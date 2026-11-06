// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PackedUserOperation, Execution} from "../../src/modules/interfaces/IERC7579Modules.sol";
import {LeakedPolicyHook} from "../../src/modules/LeakedPolicyHook.sol";
import {LeakedRoleExecutor} from "../../src/modules/LeakedRoleExecutor.sol";
import {MockToken} from "./mocks/ModuleMocks.sol";
import {LeakedModulesBase} from "./LeakedModulesBase.sol";

/// A contract whose fallback must never run from a hot batch: a zero-value empty call or ETH with calldata is not a
/// payment (it needs a session or the allowlist). A plain ETH send (value, no data) is a payment in Open.
contract FallbackProbe {
    uint256 public hits;

    fallback() external payable {
        if (msg.value == 0 || msg.data.length != 0) hits++;
    }
}

/// Plays hot key, vault, recovery, attacker and time against an MSA account with the three modules, through the
/// real EntryPoint. Mirrors plan §10.7.1 layer 3 for the 4337 backend, in Open or Strict recipient mode.
contract ModulesHandler is LeakedModulesBase {
    uint256 public t0;
    uint256 public cap0;
    uint256 public hotOutUsd; // USD that left the account through hot userOps, plus registered-hash debits
    bool public unauthorizedWrite; // any policy write that did not come from a PQ-authorised path
    bool public vaultActedDuringRotation;
    bool public rotationCleared; // pending rotation ended other than by finalize/cancel
    bool public rotationPending;
    uint256 public hotOps;
    bool public strictNow; // the recipient mode the vault last set (or installed)
    bool public recipientViolation; // a hot payment to a non-allowlisted address went through while Strict
    FallbackProbe public probe;
    address[4] internal sinks;
    /// A hot payment that reached a self-defeating recipient (an allowlisted token, a guardian, the moved token, a
    /// module), in either mode (the account's `ForbiddenRecipient`).
    bool public forbiddenPaid;
    /// Ever accepted: a recovery key equal to the vault's, or a vault rotation to the recovery's key.
    bool public sameKeyAccepted;
    MockToken internal dai;

    function _host() internal pure override returns (Host) {
        return Host.MSA;
    }

    function _recipientMode() internal view override returns (RecipientMode) {
        return strictNow ? RecipientMode.Strict : RecipientMode.Open;
    }

    /// Install data with a second listed token (`HookInit.tokens`), a possible forbidden recipient.
    function _hookInit() internal view override returns (HookInit memory c) {
        c = super._hookInit();
        TokenInit[] memory t = new TokenInit[](2);
        t[0] = c.tokens[0];
        t[1] = TokenInit(address(dai), 18, 1e6);
        c.tokens = t;
    }

    function init(bool strict) external {
        strictNow = strict;
        dai = new MockToken("DAI", 18);
        setUp();
        probe = new FallbackProbe();
        sinks = [recipient, stranger, makeAddr("fresh"), address(probe)];
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

    /// ETH / USDC to any of: the allowlisted recipient, never-allowlisted EOAs, a contract with a fallback.
    function hotEthTo(uint256 seed, uint256 amount) external {
        address to = sinks[seed % 4];
        amount = bound(amount, 1, 0.2 ether);
        _hotTo(to, _single(to, amount, ""));
    }

    function hotUsdcTo(uint256 seed, uint256 amount) external {
        address to = sinks[seed % 4];
        amount = bound(amount, 1, 600e6);
        _hotTo(to, _single(address(usdc), 0, abi.encodeCall(IERC20.transfer, (to, amount))));
    }

    /// Never a payment: zero-value empty calls and ETH with calldata (the probe counts any that runs).
    function hotNonPayment(uint256 seed, uint256 amount) external {
        address to = sinks[1 + (seed % 3)];
        amount = bound(amount, 0, 0.01 ether);
        _hot(_single(to, seed % 2 == 0 ? 0 : amount, seed % 2 == 0 ? bytes("") : bytes(hex"deadbeef")));
    }

    /// ETH / USDC to a forbidden recipient (never allowlisted here): must never arrive, in either mode.
    function hotForbidden(uint256 seed, uint256 amount, bool eth) external {
        address[5] memory bad = [address(dai), guardian, address(usdc), address(hook), address(executor)];
        address to = bad[seed % 5];
        uint256 u0 = usdc.balanceOf(to);
        uint256 e0 = to.balance;
        if (eth) _hot(_single(to, bound(amount, 1, 0.2 ether), ""));
        else _hot(_single(address(usdc), 0, abi.encodeCall(IERC20.transfer, (to, bound(amount, 1, 600e6)))));
        if (usdc.balanceOf(to) != u0 || to.balance != e0) forbiddenPaid = true;
    }

    /// Tries to give the recovery the vault's key (queued change) or to rotate the vault to the recovery's key.
    function trySameRoleKey(bool rotate) external {
        if (rotate) {
            if (rotationPending) return;
            uint256 rn = _recoveryNonce();
            bytes memory sig = _pqSign(recoveryPk, executor.hashRecoveryRotate(account, rn, recoveryPk));
            try executor.recoveryStartVaultRotation(account, recoveryPk, rn, sig) {
                sameKeyAccepted = true;
            } catch {}
            return;
        }
        Call[] memory c =
            _calls1(address(executor), 0, abi.encodeCall(LeakedRoleExecutor.setRecoveryKey, (account, vaultPk)));
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultQueue(account, n, c, 1));
        bytes32 opId;
        try executor.vaultQueue(account, c, 1, n, sig) returns (bytes32 id) {
            opId = id;
        } catch {
            return;
        }
        if (rotationPending) vaultActedDuringRotation = true;
        vm.warp(block.timestamp + 48 hours);
        try executor.executeQueued(account, opId, c) {
            sameKeyAccepted = true;
        } catch {}
        if (rotationPending != executor.rotationPending(account)) rotationCleared = true;
    }

    function rolesIndependent() external view returns (bool) {
        (,, bytes32 v, bytes32 r,,,, bytes32 pending,) = executor.getRoles(account);
        return v != r && (pending == bytes32(0) || pending != r);
    }

    function _hotTo(address to, bytes memory executeCall) internal {
        uint256 u0 = usdc.balanceOf(to);
        uint256 e0 = to.balance;
        _hot(executeCall);
        bool moved = usdc.balanceOf(to) != u0 || to.balance != e0;
        if (moved && strictNow && to != recipient) recipientViolation = true;
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
        uint256[4] memory e0;
        for (uint256 i; i < 4; ++i) {
            e0[i] = sinks[i].balance;
        }
        try this.submitExternal(_op(executeCall)) returns (bool success) {
            executed = success;
        } catch {}
        // The account's ETH also pays gas: count the ETH that reached any sink, and all USDC that left.
        uint256 ethOut;
        for (uint256 i; i < 4; ++i) {
            ethOut += sinks[i].balance - e0[i];
        }
        outUsd = (u0 - usdc.balanceOf(account)) + (ethOut * ETH_USD) / 1e18;
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

    function vaultStrict() external {
        if (_tryVault(_hookCall(abi.encodeCall(LeakedPolicyHook.setRecipientMode, (account, RecipientMode.Strict))))) {
            strictNow = true;
        }
    }

    /// Strict -> Open without the queue must fail (Open -> Open is a no-op and may pass).
    function vaultTryOpenInstant() external {
        bool wasStrict = strictNow;
        bool ok = _tryVault(_hookCall(abi.encodeCall(LeakedPolicyHook.setRecipientMode, (account, RecipientMode.Open))));
        if (ok && wasStrict) unauthorizedWrite = true;
    }

    function vaultQueueOpen() external {
        Call[] memory c = _hookCall(abi.encodeCall(LeakedPolicyHook.setRecipientMode, (account, RecipientMode.Open)));
        uint256 n = _vaultNonce();
        bytes memory sig = _pqSign(vaultPk, executor.hashVaultQueue(account, n, c, 1));
        bytes32 opId;
        try executor.vaultQueue(account, c, 1, n, sig) returns (bytes32 id) {
            opId = id;
        } catch {
            return;
        }
        if (rotationPending) vaultActedDuringRotation = true;
        vm.warp(block.timestamp + 48 hours);
        try executor.executeQueued(account, opId, c) {
            strictNow = false;
        } catch {}
        if (rotationPending != executor.rotationPending(account)) rotationCleared = true;
    }

    function modeNow() external view returns (bool strict) {
        strict = hook.recipientMode(account) == RecipientMode.Strict;
    }

    function probeHits() external view returns (uint256) {
        return probe.hits();
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

    function _strict() internal pure virtual returns (bool) {
        return false;
    }

    function setUp() public {
        h = new ModulesHandler();
        h.init(_strict());
        targetContract(address(h));
        bytes4[] memory sels = new bytes4[](20);
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
        sels[11] = h.hotEthTo.selector;
        sels[12] = h.hotUsdcTo.selector;
        sels[13] = h.hotNonPayment.selector;
        sels[14] = h.vaultStrict.selector;
        sels[15] = h.vaultTryOpenInstant.selector;
        sels[16] = h.vaultQueueOpen.selector;
        sels[17] = h.hotEthTo.selector; // weight: payments to arbitrary recipients
        sels[18] = h.hotForbidden.selector;
        sels[19] = h.trySameRoleKey.selector;
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

    /// I-8 analogue (recipient policy): Strict admits only allowlisted recipients; in both modes no hot batch runs a
    /// contract's fallback through a non-payment; the mode changes only through the vault, loosening only queued.
    function invariant_recipientPolicy() public view {
        assertFalse(h.recipientViolation(), "Strict payment to a non-allowlisted recipient");
        assertEq(h.probeHits(), 0, "a hot non-payment ran a fallback");
        assertEq(h.modeNow(), h.strictNow(), "mode changed outside the vault paths");
        assertFalse(h.forbiddenPaid(), "a hot payment reached a self-defeating recipient");
    }

    /// SameRoleKey (mirrors the account): the vault and the recovery (and a pending vault) never share a PQ key.
    function invariant_rolesIndependent() public view {
        assertFalse(h.sameKeyAccepted(), "a same-key role install was accepted");
        assertTrue(h.rolesIndependent(), "vault and recovery share a key");
    }
}

contract LeakedModulesInvariantsStrictTest is LeakedModulesInvariantsTest {
    function _strict() internal pure override returns (bool) {
        return true;
    }
}
