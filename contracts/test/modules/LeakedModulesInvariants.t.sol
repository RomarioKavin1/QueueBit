// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PackedUserOperation, Execution} from "../../src/modules/interfaces/IERC7579Modules.sol";
import {LeakedPolicyHook} from "../../src/modules/LeakedPolicyHook.sol";
import {LeakedModulesBase} from "./LeakedModulesBase.sol";

/// Plays hot key, vault, recovery, attacker and time against an MSA account with the three modules, through the
/// real EntryPoint. Mirrors plan §10.7.1 layer 3 for the 4337 backend.
contract ModulesHandler is LeakedModulesBase {
    uint256 public t0;
    uint256 public cap0;
    uint256 public hotOutUsd; // USD that left the account through hot userOps, plus registered-hash debits
    bool public unauthorizedWrite; // any policy write that did not come from a PQ-authorised path
    bool public vaultActedDuringRotation;
    bool public rotationCleared; // pending rotation ended other than by finalize/cancel
    bool public rotationPending;
    uint256 public hotOps;

    function _host() internal pure override returns (Host) {
        return Host.MSA;
    }

    function init() external {
        setUp();
        t0 = block.timestamp;
        cap0 = CAP;
        vm.deal(account, 1000 ether);
        usdc.mint(account, 1_000_000e6);
    }

    // ---- hot ----

    function hotEth(uint256 amount) external {
        amount = bound(amount, 1, 0.2 ether);
        _hot(_single(recipient, amount, ""));
    }

    function hotUsdc(uint256 amount) external {
        amount = bound(amount, 1, 600e6);
        _hot(_single(address(usdc), 0, abi.encodeCall(IERC20.transfer, (recipient, amount))));
    }

    function hotRegister(uint256 amount) external {
        amount = bound(amount, 1, 600e6);
        bytes memory call = abi.encodeCall(
            LeakedPolicyHook.registerHash,
            (keccak256(abi.encode(amount, block.timestamp)), address(usdc), amount, uint48(block.timestamp + 1 days))
        );
        (bool ok,) = _hot(_single(address(hook), 0, call));
        if (ok) hotOutUsd += amount;
    }

    function hotTryWritePolicy(uint256 which) external {
        bytes memory data = which % 2 == 0
            ? abi.encodeCall(LeakedPolicyHook.setCap, (account, 1e30, 1e20, 1 ether, 1 gwei))
            : abi.encodeCall(LeakedPolicyHook.setTarget, (account, stranger, true));
        (bool ok,) = _hot(_single(address(hook), 0, data));
        if (ok) unauthorizedWrite = true;
    }

    function _hot(bytes memory executeCall) internal returns (bool executed, uint256 outUsd) {
        uint256 u0 = usdc.balanceOf(account);
        uint256 r0 = recipient.balance;
        try this.submitExternal(_op(executeCall)) returns (bool success) {
            executed = success;
        } catch {}
        // The account's ETH also pays gas: count the ETH that reached the recipient, and all USDC that left.
        outUsd = (u0 - usdc.balanceOf(account)) + ((recipient.balance - r0) * ETH_USD) / 1e18;
        hotOps++;
        hotOutUsd += outUsd;
    }

    /// handleOps reverts on a validation failure; on success, whether the op's execution succeeded.
    function submitExternal(PackedUserOperation memory op) external returns (bool) {
        require(msg.sender == address(this));
        return _submit(op).success;
    }

    // ---- attacker ----

    function attackerWrite(address who, uint256 which) external {
        vm.assume(who != address(executor));
        vm.startPrank(who);
        bool ok;
        if (which % 3 == 0) {
            (ok,) = address(hook).call(abi.encodeCall(LeakedPolicyHook.setCap, (account, 1e30, 1e20, 1, 1)));
        } else if (which % 3 == 1) {
            (ok,) = address(hook).call(abi.encodeCall(LeakedPolicyHook.setHotKey, (account, who)));
        } else {
            (ok,) = address(hook).call(abi.encodeCall(LeakedPolicyHook.unfreeze, (account)));
        }
        vm.stopPrank();
        if (ok) unauthorizedWrite = true;
    }

    // ---- vault ----

    function vaultTighten(uint256 newCap) external {
        (,, uint256 cap) = hook.getBucket(account);
        newCap = bound(newCap, 100e6, cap);
        Call[] memory c =
            _hookCall(abi.encodeCall(LeakedPolicyHook.setCap, (account, newCap, PER_TX, MAX_FEE_WEI, MAX_PRIO)));
        _tryVault(c);
    }

    function vaultTryLoosenInstant() external {
        Call[] memory c =
            _hookCall(abi.encodeCall(LeakedPolicyHook.setCap, (account, 1e30, 1e20, MAX_FEE_WEI, MAX_PRIO)));
        if (_tryVault(c)) unauthorizedWrite = true;
    }

    function vaultSpend(uint256 amount) external {
        amount = bound(amount, 1, 1 ether);
        _tryVault(_calls1(stranger, amount, ""));
    }

    function _tryVault(Call[] memory c) internal returns (bool ok) {
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultExec(account, n, c, 0));
        try executor.vaultExec(account, c, 0, n, sig) {
            ok = true;
        } catch {}
        if (ok && rotationPending) vaultActedDuringRotation = true;
    }

    // ---- recovery ----

    function recoveryStart() external {
        if (rotationPending) return;
        uint256 rn = _recoveryNonce();
        bytes32 pk = keccak256(abi.encode("v", rn));
        bytes memory sig = _pqSign(recoveryPk, executor.hashRecoveryRotate(account, rn, pk));
        executor.recoveryStartVaultRotation(account, pk, rn, sig);
        rotationPending = true;
        pendingPk = pk;
    }

    bytes32 internal pendingPk;

    function recoveryFinalize() external {
        if (!rotationPending) return;
        try executor.recoveryFinalizeVaultRotation(account) {
            rotationPending = false;
            vaultPk = pendingPk;
        } catch {}
    }

    // ---- time ----

    function warp(uint256 dt) external {
        dt = bound(dt, 0, 2 days);
        vm.warp(block.timestamp + dt);
        if (rotationPending != executor.rotationPending(account)) rotationCleared = true;
    }

    function capNow() external view returns (uint256 cap) {
        (,, cap) = hook.getBucket(account);
    }
}

contract LeakedModulesInvariantsTest is Test {
    ModulesHandler internal h;

    function setUp() public {
        h = new ModulesHandler();
        h.init();
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](11);
        sels[0] = h.hotEth.selector;
        sels[1] = h.hotUsdc.selector;
        sels[2] = h.hotRegister.selector;
        sels[3] = h.hotTryWritePolicy.selector;
        sels[4] = h.attackerWrite.selector;
        sels[5] = h.vaultTighten.selector;
        sels[6] = h.vaultTryLoosenInstant.selector;
        sels[7] = h.vaultSpend.selector;
        sels[8] = h.recoveryStart.selector;
        sels[9] = h.recoveryFinalize.selector;
        sels[10] = h.warp.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sels}));
    }

    /// I-1: over any window, hot outflow <= cap + elapsed x cap / 1 day (the cap can only be tightened here).
    function invariant_hotOutflowBounded() public view {
        uint256 elapsed = block.timestamp - h.t0();
        assertLe(h.hotOutUsd(), h.cap0() + (elapsed * h.cap0()) / 1 days);
    }

    /// I-2 analogue: policy is written only through the PQ-authorised executor, and loosening only through the queue.
    function invariant_vaultOnlyWritesAndNoInstantLoosening() public view {
        assertFalse(h.unauthorizedWrite());
        assertLe(h.capNow(), h.cap0());
    }

    /// I-4: while a recovery rotation is pending the vault cannot act, and nothing but finalize ends it.
    function invariant_recoveryOutranksVault() public view {
        assertFalse(h.vaultActedDuringRotation());
        assertFalse(h.rotationCleared());
    }
}
