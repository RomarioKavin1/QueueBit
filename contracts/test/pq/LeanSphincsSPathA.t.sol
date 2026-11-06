// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FrameSim} from "../frame/FrameSim.sol";
import {LeanSphincsSVerifier} from "../../src/pq/LeanSphincsSVerifier.sol";
import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {IStakingRegistry} from "../../src/interfaces/IStakingRegistry.sol";
import {IQueueBitAccountRoles} from "../../src/interfaces/IQueueBitAccountRoles.sol";
import {PQRoleSigner} from "../../src/roles/PQRoleSigner.sol";
import {RoleSignerFactory} from "../../src/roles/RoleSignerFactory.sol";
import {LeanSphincsSKat} from "./LeanSphincsSKat.sol";
import {C13Kat} from "./C13Kat.sol";
import {MockQueueBitAccount, MockStakingRegistry} from "../roles/RoleMocks.sol";

/// A VaultSigner clone (`RoleSignerFactory`, the production path) whose verifier is `LeanSphincsSVerifier`: Path A
/// (PQ verified inside VERIFY) and Path B work unchanged with the 4,164-byte witness (the clone's `sigLength` comes
/// from the verifier), forged witnesses are rejected, and a C13 witness is not accepted by a leanSphincs-s signer.
///
/// Gas: FrameSim's opcode mocks cost far more than the opcodes (FrameSim.sol header), so the VERIFY-frame figure it
/// logs is indicative only; the authoritative Path A VERIFY-frame gas is the devnet receipt
/// (`devnet-tests/pq/lean-path-a.ts`, recorded in IMPLEMENTATION-NOTES.md). What this test pins without mocks is the
/// real cost of the PQ part of VERIFY: the adapter call with this witness (`test_pathA_pqPartGas`).
contract LeanSphincsSPathATest is FrameSim {
    LeanSphincsSVerifier internal verifier;
    MockQueueBitAccount internal account;
    MockStakingRegistry internal registry;
    RoleSignerFactory internal factory;
    PQRoleSigner internal signer;
    LeanSphincsSKat.Vector internal kat;

    address internal payer;
    uint256 internal payerPk;
    address internal recipient = makeAddr("recipient");

    uint256 internal constant MAX_FEE = 0.05 ether;
    uint256 internal constant COST = 0.01 ether;
    /// The Path A VERIFY limit the devnet run uses: limit + 100 (ARBITRARY entry) must be <= MAX_VERIFY_GAS 100,000.
    uint64 internal constant PATH_A_VERIFY_LIMIT = 99_900;
    uint64 internal constant SENDER_GAS = 500_000;

    function setUp() public {
        kat = LeanSphincsSKat.load(1); // vault key, non-zero digest
        verifier = new LeanSphincsSVerifier();
        registry = new MockStakingRegistry();
        account = new MockQueueBitAccount();
        (payer, payerPk) = makeAddrAndKey("payer");
        factory = new RoleSignerFactory(
            Devnet.ERC8421_WORKSHOP, TxParam.MAX_COST, IStakingRegistry(address(registry)), MAX_FEE
        );
        signer = PQRoleSigner(
            payable(factory.createRoleSigner(bytes32(0), 1, address(account), kat.pk, address(verifier), payer))
        );
        simAttach(address(factory.implementation()));
        account.setRoles(address(signer), address(0), address(0));
        vm.deal(address(signer), 1 ether);
        vm.deal(address(account), 1 ether);
    }

    function _move(uint256 amount) internal view returns (bytes memory) {
        IQueueBitAccountRoles.Call[] memory calls = new IQueueBitAccountRoles.Call[](1);
        calls[0] = IQueueBitAccountRoles.Call(recipient, amount, "");
        return abi.encodeCall(IQueueBitAccountRoles.vaultExecute, (calls, 0));
    }

    function _pathA(bytes memory witness, bytes32 sigHash) internal {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(sigHash);
        simVerify(SELF_VERIFY, address(0), PATH_A_VERIFY_LIMIT, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, abi.encodeCall(PQRoleSigner.relay, (address(account), _move(0.1 ether))));
        simAddArbitrary(witness);
    }

    function test_clone_takesSigLengthFromVerifier() public view {
        assertEq(address(signer.verifier()), address(verifier));
        assertEq(signer.sigLength(), 4164);
        assertEq(signer.pk(), kat.pk);
        assertEq(signer.role(), 1);
    }

    function test_pathA_valid_movesFunds() public {
        uint256 nonce0 = vm.getNonce(address(signer));
        _pathA(kat.sig, kat.digest);
        SimResult memory r = simRunValid();
        assertFalse(r.frames[0].staticViolation, "VERIFY static");
        assertEq(r.frames[0].foreignSloads, 0, "VERIFY reads only the signer's storage");
        assertEq(r.frames[0].bannedAccesses, 0, "VERIFY banned accesses");
        assertEq(r.payer, address(signer), "self-paid");
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(recipient.balance, 0.1 ether);
        assertEq(vm.getNonce(address(signer)), nonce0 + 1);
        emit log_named_uint("FrameSim Path A VERIFY frame gasUsed (indicative: mocked opcodes)", r.frames[0].gasUsed);
    }

    function test_pathA_forged_rejected_noNonce() public {
        uint256 nonce0 = vm.getNonce(address(signer));
        bytes memory w = bytes.concat(kat.sig);
        w[2720] ^= 0x01; // WOTS+C counter
        _pathA(w, kat.digest);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(uint8(r.reason), uint8(InvalidReason.VERIFY_FAILED));
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.InvalidPQSignature.selector);
        assertEq(recipient.balance, 0);
        assertEq(vm.getNonce(address(signer)), nonce0);
    }

    function test_pathA_otherDigest_rejected() public {
        _pathA(kat.sig, keccak256("another sig hash"));
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.InvalidPQSignature.selector);
    }

    /// A C13 witness (3,688 B) fails the clone's SIGNATURE_LENGTH check before any copy or verify.
    function test_pathA_c13Witness_rejected() public {
        C13Kat.Vector memory c = C13Kat.load(1);
        _pathA(c.sig, c.digest);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadWitnessEntry.selector);
    }

    function testFuzz_pathA_flippedWitness_invalid(uint256 seed, uint16 flip) public {
        bytes memory w = bytes.concat(kat.sig);
        uint256 i = bound(flip, 0, 4163);
        w[i] = bytes1(uint8(w[i]) ^ uint8(1 + (seed % 255)));
        _pathA(w, kat.digest);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(recipient.balance, 0);
    }

    /// Path B on the same clone: payer key in VERIFY, the 4,164-byte PQ witness checked in `executePQ`.
    function test_pathB_valid_movesFunds() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), 90_000, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(
            address(0), SENDER_GAS, 0, abi.encodeCall(PQRoleSigner.executePQ, (0, address(account), _move(0.1 ether)))
        );
        simAddArbitrary(kat.sig);
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(recipient.balance, 0.1 ether);
    }

    /// The PQ part of Path A VERIFY, measured without mocks: the clone's `v.verify(key, sigHash, sig)` STATICCALL
    /// (cold verifier, as in a fresh frame tx) with the KAT C witness. With C13 the same call is ~110k, over the
    /// 100k budget on its own; with leanSphincs-s it leaves > 50k for the role-signer glue.
    function test_pathA_pqPartGas() public {
        LeanSphincsSKat.Vector memory k = LeanSphincsSKat.load(1);
        vm.cool(address(verifier));
        uint256 g0 = gasleft();
        bool ok = verifier.verify(k.pk, k.digest, k.sig);
        uint256 g = g0 - gasleft();
        assertTrue(ok);
        emit log_named_uint("leanSphincs-s adapter call, cold (PQ part of Path A VERIFY)", g);
        assertLt(g, 50_000);

        C13Verifier c13 = new C13Verifier();
        C13Kat.Vector memory c = C13Kat.load(1);
        vm.cool(address(c13));
        g0 = gasleft();
        ok = c13.verify(c.pk, c.digest, c.sig);
        uint256 gc = g0 - gasleft();
        assertTrue(ok);
        emit log_named_uint("C13 adapter call, cold (for comparison)", gc);
        assertGt(gc, 100_000);
    }
}
