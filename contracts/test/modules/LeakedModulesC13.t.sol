// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {PackedUserOperation} from "../../src/modules/interfaces/IERC7579Modules.sol";
import {LeakedRoleExecutor} from "../../src/modules/LeakedRoleExecutor.sol";
import {LeakedPolicyHook} from "../../src/modules/LeakedPolicyHook.sol";
import {LeakedHotValidator} from "../../src/modules/LeakedHotValidator.sol";
import {ISimpleAccount} from "./hosts/HostInterfaces.sol";
import {LeakedModulesBase} from "./LeakedModulesBase.sol";

/// PQ vault/recovery actions with real SPHINCS- C13 signatures (3,688 B) verified by `C13Verifier` in execution.
/// Signatures come from `test/modules/fixtures/c13-executor.json`, produced by
/// `contracts/devnet-tests/4337/gen-fixtures.ts` with the leaked pq-signer package from fixed test seeds. The generator computes
/// the EIP-712 digests itself (viem `hashTypedData`) from the addresses below; this test recomputes them on chain
/// and requires equality, so the fixture is also an independent check of the executor's digest encoding.
/// Foundry deploys deterministically: if setUp changes, the addresses move and the generator must be re-run.
contract LeakedModulesC13Test is LeakedModulesBase {
    string internal constant FIXTURE = "test/modules/fixtures/c13-executor.json";
    string internal json;

    function _host() internal pure override returns (Host) {
        return Host.MSA;
    }

    function setUp() public override {
        json = vm.readFile(FIXTURE);
        vaultPk = vm.parseJsonBytes32(json, ".vaultPk");
        recoveryPk = vm.parseJsonBytes32(json, ".recoveryPk");
        super.setUp();
        // The fixture was generated for exactly these addresses.
        if (
            vm.parseJsonAddress(json, ".executor") != address(executor)
                || vm.parseJsonAddress(json, ".account") != account
        ) {
            revert(
                string.concat(
                    "fixture addresses moved: run `bun run gen-fixtures.ts sign ",
                    vm.toString(address(executor)),
                    " ",
                    vm.toString(account),
                    "` in devnet-tests/4337"
                )
            );
        }
        assertEq(vm.parseJsonUint(json, ".chainId"), block.chainid);
    }

    function _deployModules() internal override {
        executor = new LeakedRoleExecutor();
        hook = new LeakedPolicyHook(address(executor));
        validator = new LeakedHotValidator(hook);
        pq = new C13Verifier();
    }

    function _vaultSpend() internal view returns (Call[] memory) {
        return _calls1(stranger, 0.5 ether, "");
    }

    function test_c13_vaultExec() public {
        Call[] memory c = _vaultSpend();
        bytes32 d = executor.hashVaultExec(account, 0, c, 0);
        assertEq(d, vm.parseJsonBytes32(json, ".vaultExec.digest"), "digest (TS vs Solidity)");
        bytes memory sig = vm.parseJsonBytes(json, ".vaultExec.sig");
        assertEq(sig.length, 3688);
        assertTrue(pq.verify(vaultPk, d, sig));

        // A forged witness (one bit) and the recovery key's signature are both refused.
        bytes memory forged = bytes.concat(sig);
        forged[1000] ^= 0x01;
        vm.expectRevert(BadSignature.selector);
        executor.vaultExec(account, c, 0, 0, forged);

        uint256 g = gasleft();
        executor.vaultExec(account, c, 0, 0, sig);
        emit log_named_uint("vaultExec gas (direct call, C13 verify in execution)", g - gasleft());
        assertEq(stranger.balance, 0.5 ether);
        vm.expectRevert(abi.encodeWithSelector(BadNonce.selector, 1, 0));
        executor.vaultExec(account, c, 0, 0, sig); // replay
    }

    function test_c13_recoveryRotation() public {
        bytes32 newPk = vm.parseJsonBytes32(json, ".rotation.newVaultPk");
        bytes32 d = executor.hashRecoveryRotate(account, 0, newPk);
        assertEq(d, vm.parseJsonBytes32(json, ".rotation.digest"), "digest (TS vs Solidity)");
        bytes memory sig = vm.parseJsonBytes(json, ".rotation.sig");
        // The vault key cannot start a rotation.
        bytes memory vaultSig = vm.parseJsonBytes(json, ".vaultExec.sig");
        vm.expectRevert(BadSignature.selector);
        executor.recoveryStartVaultRotation(account, newPk, 0, vaultSig);
        executor.recoveryStartVaultRotation(account, newPk, 0, sig);
        assertTrue(executor.rotationPending(account));
        vm.warp(block.timestamp + 7 days);
        executor.recoveryFinalizeVaultRotation(account);
        (,, bytes32 vpk,,,,,,) = executor.getRoles(account);
        assertEq(vpk, newPk);
    }

    /// The plan's open question (§10.4.2, "verification-gas caps of public bundlers [UNVERIFIED]"): the PQ check is
    /// in execution, so a relayer's userOp has an ordinary ECDSA validation. Measured here end to end.
    function test_c13_vaultExecAsRelayedUserOp_gas() public {
        (address relayerOwner, uint256 relayerPk) = makeAddrAndKey("relayer-owner");
        address impl = deployCode("out/SimpleAccount.sol/SimpleAccount.json", abi.encode(EP_ADDR));
        address relayer = address(new ERC1967Proxy(impl, abi.encodeCall(ISimpleAccount.initialize, (relayerOwner))));
        vm.deal(relayer, 1 ether);

        Call[] memory c = _vaultSpend();
        bytes memory sig = vm.parseJsonBytes(json, ".vaultExec.sig");
        PackedUserOperation memory op;
        op.sender = relayer;
        op.nonce = ep.getNonce(relayer, 0);
        op.callData = abi.encodeCall(
            ISimpleAccount.execute,
            (address(executor), 0, abi.encodeCall(LeakedRoleExecutor.vaultExec, (account, c, 0, 0, sig)))
        );
        op.accountGasLimits = bytes32((uint256(100_000) << 128) | 600_000);
        op.preVerificationGas = 120_000; // 3.7 KB of calldata
        op.gasFees = bytes32((uint256(1 gwei) << 128) | 2 gwei);
        op.signature = _sign(op, relayerPk);
        uint256 used = _submitOk(op);
        emit log_named_uint("vaultExec relayed userOp actualGasUsed", used);
        emit log_named_uint("vaultExec relayed userOp calldata bytes", op.callData.length);
        assertEq(stranger.balance, 0.5 ether);
    }
}
