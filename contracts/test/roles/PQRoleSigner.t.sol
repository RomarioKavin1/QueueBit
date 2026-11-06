// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FrameSim} from "../frame/FrameSim.sol";
import {C13Verifier} from "../../src/pq/C13Verifier.sol";
import {IPQVerifier} from "../../src/interfaces/IPQVerifier.sol";
import {IStakingRegistry} from "../../src/interfaces/IStakingRegistry.sol";
import {IQueueBitAccountRoles} from "../../src/interfaces/IQueueBitAccountRoles.sol";
import {PQRoleSigner} from "../../src/roles/PQRoleSigner.sol";
import {RoleSignerFactory} from "../../src/roles/RoleSignerFactory.sol";
import {FeeProfile} from "../../src/roles/FeeProfile.sol";
import {C13Kat} from "../pq/C13Kat.sol";
import {MockQueueBitAccount, MockStakingRegistry, MockOther} from "./RoleMocks.sol";

/// PQRoleSigner under FrameSim (EIP-8141 semantics, mocked opcodes) with real C13 signatures from KAT set C: the
/// sig hash of each simulated tx is set to a vector's digest, so the vector's signature is a valid PQ signature over
/// it. Covers both paths, payer pinning, the frame walker, target restrictions, fee bound, self-admin, staking.
/// The signer under test is a clone from `RoleSignerFactory` (the production path): the opcode helpers are the
/// implementation's, the args are read from the clone's code, APPROVE runs through clone -> implementation ->
/// helper DELEGATECALLs.
contract PQRoleSignerTest is FrameSim {
    C13Verifier internal verifier;
    MockQueueBitAccount internal account;
    MockStakingRegistry internal registry;
    RoleSignerFactory internal factory;
    PQRoleSigner internal signer;
    C13Kat.Vector internal kat;

    address internal payer;
    uint256 internal payerPk;
    address internal recipient = makeAddr("recipient");

    uint256 internal constant MAX_FEE = 0.05 ether;
    uint256 internal constant COST = 0.01 ether;
    uint64 internal constant VERIFY_GAS = 90_000;
    uint64 internal constant SENDER_GAS = 500_000;

    function setUp() public {
        kat = C13Kat.load(1); // non-zero digest, vault key
        verifier = new C13Verifier();
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

    // ------------------------------------------------------------------------------------------- builders ------

    function _move(uint256 amount) internal view returns (bytes memory) {
        IQueueBitAccountRoles.Call[] memory calls = new IQueueBitAccountRoles.Call[](1);
        calls[0] = IQueueBitAccountRoles.Call(recipient, amount, "");
        return abi.encodeCall(IQueueBitAccountRoles.vaultExecute, (calls, 0));
    }

    function _execPQ(address target, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(PQRoleSigner.executePQ, (0, target, data));
    }

    function _relay(address target, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(PQRoleSigner.relay, (target, data));
    }

    /// Path B: [VERIFY 0x3 verifyFrame(0), SENDER(self, body)], sigs [ARBITRARY witness, SECP256K1 payer].
    function _pathB(bytes memory body, bytes memory witness, uint256 payerKeyPk, address payerAddr) internal {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, body);
        simAddArbitrary(witness);
        simAddSecp256k1(payerAddr);
        simSignSecp256k1(1, payerKeyPk);
    }

    function _pathB(bytes memory body) internal {
        _pathB(body, kat.sig, payerPk, payer);
    }

    /// Path A: [VERIFY 0x3 verifyFrame(0), SENDER(self, body)], sigs [ARBITRARY witness].
    function _pathA(bytes memory body, bytes memory witness) internal {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), 300_000, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, body);
        simAddArbitrary(witness);
    }

    function _forged() internal view returns (bytes memory s) {
        s = bytes.concat(kat.sig);
        s[100] ^= 0x01;
    }

    function _assertVerifyClean(SimResult memory r) internal pure {
        assertFalse(r.frames[0].staticViolation, "VERIFY static");
        assertEq(r.frames[0].foreignSloads, 0, "VERIFY reads only the signer's storage");
        assertEq(r.frames[0].bannedAccesses, 0, "VERIFY banned accesses");
    }

    // --------------------------------------------------------------------------------------------- Path B ------

    function test_pathB_valid_movesFunds() public {
        uint256 nonce0 = vm.getNonce(address(signer));
        _pathB(_execPQ(address(account), _move(0.1 ether)));
        SimResult memory r = simRunValid();
        _assertVerifyClean(r);
        assertEq(r.payer, address(signer), "self-paid");
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(recipient.balance, 0.1 ether);
        assertEq(account.vaultCalls(), 1);
        assertEq(vm.getNonce(address(signer)), nonce0 + 1);
    }

    function test_pathB_forgedPQ_movesNothing_butBurnsNonce() public {
        uint256 nonce0 = vm.getNonce(address(signer));
        uint256 bal0 = address(signer).balance;
        _pathB(_execPQ(address(account), _move(0.1 ether)), _forged(), payerPk, payer);
        SimResult memory r = simRun();
        // the payer key authorises the tx, so it is valid and pays; the PQ check fails in execution
        assertTrue(r.valid);
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.InvalidPQSignature.selector);
        assertEq(recipient.balance, 0);
        assertEq(account.vaultCalls(), 0);
        assertEq(vm.getNonce(address(signer)), nonce0 + 1, "nonce consumed (only the payer key can cause this)");
        assertEq(address(signer).balance, bal0 - COST, "gas bounded by maxFee");
    }

    function test_pathB_wrongPayer_rejectedInVerify() public {
        (address mallory, uint256 malloryPk) = makeAddrAndKey("mallory");
        uint256 nonce0 = vm.getNonce(address(signer));
        _pathB(_execPQ(address(account), _move(0.1 ether)), kat.sig, malloryPk, mallory);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(uint8(r.reason), uint8(InvalidReason.VERIFY_FAILED));
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadPayerEntry.selector);
        assertEq(recipient.balance, 0);
        assertEq(vm.getNonce(address(signer)), nonce0, "invalid tx: no nonce consumed");
    }

    function test_pathB_payerEntryNotSecp_rejected() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, _execPQ(address(account), _move(1)));
        simAddArbitrary(kat.sig);
        simAddArbitrary(kat.sig); // second ARBITRARY instead of the payer's ECDSA: must not read RESOLVED_SIGNER
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadPayerEntry.selector);
    }

    function test_pathB_payerMsgNonZero_rejected() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, _execPQ(address(account), _move(1)));
        simAddArbitrary(kat.sig);
        simAddSig(SCHEME_SECP256K1, payer, keccak256("other digest"), "");
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadPayerEntry.selector);
    }

    function test_pathB_disabledPayer_rejected() public {
        // the PQ key turns Path B off through its own Path B tx...
        _pathB(_execPQ(address(signer), abi.encodeCall(PQRoleSigner.setPayerKey, (address(0)))));
        simRunValid();
        assertEq(signer.payerKey(), address(0));
        // ...after which the old payer key can not even get a tx admitted
        _pathB(_execPQ(address(account), _move(1)));
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.PathBDisabled.selector);
    }

    function test_pathB_witnessWrongLength_rejectedBeforeCopy() public {
        bytes memory shortSig = new bytes(3687);
        for (uint256 i; i < 3687; i++) {
            shortSig[i] = kat.sig[i];
        }
        _pathB(_execPQ(address(account), _move(1)), shortSig, payerPk, payer);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadWitnessEntry.selector);
    }

    /// `sigIndex` names the witness entry; the payer is the other one. The reverse layout [SECP256K1 payer,
    /// ARBITRARY witness] with `verifyFrame(1)` / `executePQ(1, ...)` is a valid Path B tx.
    function test_pathB_witnessAtIndex1_payerAtIndex0_valid() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (1)));
        simSender(
            address(0), SENDER_GAS, 0, abi.encodeCall(PQRoleSigner.executePQ, (1, address(account), _move(0.1 ether)))
        );
        simAddSecp256k1(payer);
        simAddArbitrary(kat.sig);
        simSignSecp256k1(0, payerPk);
        SimResult memory r = simRunValid();
        _assertVerifyClean(r);
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(recipient.balance, 0.1 ether);
    }

    /// `verifyFrame(1)` against the standard layout names the SECP256K1 entry as the witness: rejected on SCHEME,
    /// before SIGNATURE_LENGTH / SIGDATACOPY could be asked of a SECP256K1 entry.
    function test_pathB_sigIndexNamesPayerEntry_rejectedWithoutHalting() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (1)));
        simSender(address(0), SENDER_GAS, 0, abi.encodeCall(PQRoleSigner.executePQ, (1, address(account), _move(1))));
        simAddArbitrary(kat.sig);
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadWitnessEntry.selector);
    }

    /// The witness is bound to this transaction's sig hash: the same (valid) witness over another sig hash is
    /// admitted by the payer key but rejected in `executePQ`, so nothing moves.
    function test_pathB_witnessOverOtherSigHash_rejectedInExecute() public {
        _pathB(_execPQ(address(account), _move(0.1 ether)));
        simSetSigHash(keccak256("another transaction"));
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertTrue(r.valid);
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.InvalidPQSignature.selector);
        assertEq(recipient.balance, 0);
    }

    /// Path A with `verifyFrame(1)`: out of range for a single entry (and never a RESOLVED_SIGNER read).
    function test_pathA_sigIndexOutOfRange_rejected() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), 300_000, abi.encodeCall(PQRoleSigner.verifyFrame, (1)));
        simSender(address(0), SENDER_GAS, 0, _relay(address(account), _move(1)));
        simAddArbitrary(kat.sig);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadWitnessEntry.selector);
    }

    /// `feeParam = MAX_FEE` (the EIP master profile, where 0x04 is the total budget): the bound applies to 0x04.
    ///      (Built for the EIP-7906 workshop helper set: `FeeProfile` refuses MAX_FEE on the chain-1337 profile.)
    function test_feeBound_maxFeeProfile() public {
        RoleSignerFactory g = new RoleSignerFactory(
            Devnet.EIP7906_WORKSHOP, TxParam.MAX_FEE, IStakingRegistry(address(registry)), MAX_FEE
        );
        PQRoleSigner s =
            PQRoleSigner(payable(g.createRoleSigner(bytes32(0), 1, address(account), kat.pk, address(verifier), payer)));
        simAttach(address(g.implementation()), Devnet.EIP7906_WORKSHOP);
        vm.deal(address(s), 1 ether);
        simBegin(address(s));
        simSetFees(1 gwei, MAX_FEE + 1, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, _execPQ(address(account), _move(1)));
        simAddArbitrary(kat.sig);
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.FeeTooHigh.selector);
        // and MAX_COST above the bound is not what this profile checks
        simSetFees(1 gwei, MAX_FEE, MAX_FEE + 1);
        simSignSecp256k1(1, payerPk);
        r = simRun();
        assertTrue(r.valid);
    }

    function test_pathB_witnessExplicitMsg_rejected() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, _execPQ(address(account), _move(1)));
        simAddSig(SCHEME_ARBITRARY, address(0), kat.digest, kat.sig); // signs an explicit digest, not the sig hash
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadWitnessEntry.selector);
    }

    function test_pathB_entriesSwapped_rejectedWithoutHalting() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, _execPQ(address(account), _move(1)));
        simAddSecp256k1(payer);
        simAddArbitrary(kat.sig);
        simSignSecp256k1(0, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        // a custom error, not FrameSimHalt: SIGNATURE_LENGTH / SIGDATACOPY were never asked of the SECP256K1 entry
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadWitnessEntry.selector);
    }

    function test_pathB_feeAboveBound_rejected() public {
        _pathB(_execPQ(address(account), _move(1)));
        simSetFees(1 gwei, 2 gwei, MAX_FEE + 1);
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.FeeTooHigh.selector);
    }

    // ------------------------------------------------------------------------------------------- walker ------

    function test_walker_pathB_relaySelector_rejected() public {
        // relay skips the PQ check, so Path B (payer-key VERIFY) must never admit it
        _pathB(_relay(address(account), _move(0.1 ether)));
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadFrameShape.selector);
        assertEq(recipient.balance, 0);
    }

    function test_walker_senderTargetsAccountDirectly_rejected() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(account), SENDER_GAS, 0, _move(0.1 ether));
        simAddArbitrary(kat.sig);
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadFrameShape.selector);
    }

    function test_walker_extraSenderFrame_rejected() public {
        _pathB(_execPQ(address(account), _move(0.1 ether)));
        simSender(address(account), SENDER_GAS, 0, _move(0.1 ether));
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadFrameShape.selector);
    }

    function test_walker_senderWithValue_rejected() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 1, _execPQ(address(account), _move(1)));
        simAddArbitrary(kat.sig);
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadFrameShape.selector);
    }

    function test_walker_executePQIndexMismatch_rejected() public {
        _pathB(abi.encodeCall(PQRoleSigner.executePQ, (1, address(account), _move(1))));
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadFrameShape.selector);
    }

    function test_walker_onlyVerifyScope_rejected() public {
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(ONLY_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, _execPQ(address(account), _move(1)));
        simAddArbitrary(kat.sig);
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.ScopeNotSelfVerify.selector);
    }

    function test_walker_defaultFrameCannotReachApprove() public {
        simBegin(address(signer));
        simSetSigHash(kat.digest);
        simDefault(address(signer), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simAddArbitrary(kat.sig);
        simEnter(0);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(PQRoleSigner.NotVerifyFrame.selector);
        signer.verifyFrame(0);
        simLeave(0, STATUS_FAILED);
    }

    function test_walker_threeSignatures_rejected() public {
        _pathB(_execPQ(address(account), _move(1)));
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
        simSignSecp256k1(2, payerPk);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadSignatureCount.selector);
    }

    // ------------------------------------------------------------------------------------------ targets ------

    function test_target_other_rejected() public {
        MockOther other = new MockOther();
        _pathB(_execPQ(address(other), abi.encodeCall(MockOther.hit, ())));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.TargetNotAllowed.selector);
        assertEq(other.hits(), 0);
    }

    function test_target_selfNonAdminSelector_rejected() public {
        // no nested executePQ / relay through the self target
        _pathB(_execPQ(address(signer), _relay(address(account), _move(0.1 ether))));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.TargetNotAllowed.selector);
        assertEq(recipient.balance, 0);
    }

    function test_target_selfShortData_rejected() public {
        // a self call with no selector (receive) is not one of the six admin functions
        _pathB(_execPQ(address(signer), ""));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.TargetNotAllowed.selector);
        _pathB(_execPQ(address(signer), hex"aabb"));
        r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.TargetNotAllowed.selector);
    }

    function test_target_accountAnyCalldata_forwarded() public {
        // the account authorises by msg.sender; the signer does not decode its calldata (empty data = receive)
        uint256 bal0 = address(account).balance;
        _pathB(_execPQ(address(account), ""));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(address(account).balance, bal0);
        // the account's revert bubbles up unchanged
        _pathB(_execPQ(address(account), abi.encodeCall(IQueueBitAccountRoles.recoveryCancel, (bytes32(0)))));
        r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), MockQueueBitAccount.NotRecovery.selector);
    }

    function testFuzz_target_onlyAccountOrSelf(address target, bytes memory data) public {
        vm.assume(target != address(account) && target != address(signer));
        _pathB(_execPQ(target, data));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.TargetNotAllowed.selector);
    }

    function test_selfAdmin_viaExecutePQ() public {
        _pathB(_execPQ(address(signer), abi.encodeCall(PQRoleSigner.setMaxFee, (0.02 ether))));
        simRunValid();
        assertEq(signer.maxFee(), 0.02 ether);
        _pathB(_execPQ(address(signer), abi.encodeCall(PQRoleSigner.setPathA, (true))));
        simRunValid();
        assertTrue(signer.pathAEnabled());
        address newPayer = makeAddr("newPayer");
        _pathB(_execPQ(address(signer), abi.encodeCall(PQRoleSigner.setPayerKey, (newPayer))));
        simRunValid();
        assertEq(signer.payerKey(), newPayer);
    }

    function test_directCalls_onlySelf() public {
        vm.expectRevert(PQRoleSigner.OnlySelf.selector);
        signer.executePQ(0, address(account), _move(1));
        vm.expectRevert(PQRoleSigner.OnlySelf.selector);
        signer.relay(address(account), _move(1));
        vm.expectRevert(PQRoleSigner.OnlySelf.selector);
        signer.setPayerKey(address(this));
        vm.expectRevert(PQRoleSigner.OnlySelf.selector);
        signer.setPathA(true);
        vm.expectRevert(PQRoleSigner.OnlySelf.selector);
        signer.setMaxFee(1);
        vm.expectRevert(PQRoleSigner.OnlySelf.selector);
        signer.stake(86400, 1);
        vm.expectRevert(PQRoleSigner.OnlySelf.selector);
        signer.unlockStake();
        vm.expectRevert(PQRoleSigner.OnlySelf.selector);
        signer.withdrawStake(payable(address(this)));
        // the account itself only listens to the signer
        vm.expectRevert(MockQueueBitAccount.NotVault.selector);
        account.vaultExecute(new IQueueBitAccountRoles.Call[](0), 0);
    }

    // ------------------------------------------------------------------------------------------ staking ------

    function test_stake_unlock_withdraw() public {
        _pathB(_execPQ(address(signer), abi.encodeCall(PQRoleSigner.stake, (86400, 0.012 ether))));
        simRunValid();
        (uint256 s, uint32 d, uint64 w) = registry.getDepositInfo(address(signer));
        assertEq(s, 0.012 ether);
        assertEq(d, 86400);
        assertEq(w, 0);

        _pathB(_execPQ(address(signer), abi.encodeCall(PQRoleSigner.unlockStake, ())));
        simRunValid();
        (,, w) = registry.getDepositInfo(address(signer));
        assertEq(w, vm.getBlockTimestamp() + 86400);

        vm.warp(vm.getBlockTimestamp() + 86400);
        address payable to = payable(makeAddr("stakeTo"));
        _pathB(_execPQ(address(signer), abi.encodeCall(PQRoleSigner.withdrawStake, (to))));
        simRunValid();
        assertEq(to.balance, 0.012 ether);
    }

    function test_stake_viaPathA_relay() public {
        _pathA(_relay(address(signer), abi.encodeCall(PQRoleSigner.stake, (86400, 0.012 ether))), kat.sig);
        simRunValid();
        (uint256 s,,) = registry.getDepositInfo(address(signer));
        assertEq(s, 0.012 ether);
    }

    // --------------------------------------------------------------------------------------------- Path A ------

    function test_pathA_valid_movesFunds() public {
        uint256 nonce0 = vm.getNonce(address(signer));
        _pathA(_relay(address(account), _move(0.1 ether)), kat.sig);
        SimResult memory r = simRunValid();
        _assertVerifyClean(r);
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(recipient.balance, 0.1 ether);
        assertEq(vm.getNonce(address(signer)), nonce0 + 1);
    }

    function test_pathA_forgedPQ_invalid_noNonce() public {
        uint256 nonce0 = vm.getNonce(address(signer));
        uint256 bal0 = address(signer).balance;
        _pathA(_relay(address(account), _move(0.1 ether)), _forged());
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(uint8(r.reason), uint8(InvalidReason.VERIFY_FAILED));
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.InvalidPQSignature.selector);
        assertEq(recipient.balance, 0);
        assertEq(vm.getNonce(address(signer)), nonce0, "nobody can burn the nonce without the PQ key");
        assertEq(address(signer).balance, bal0);
    }

    function test_pathA_otherKeysSignature_rejected() public {
        C13Kat.Vector memory other = C13Kat.load(4); // recovery key
        simBegin(address(signer));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(other.digest);
        simVerify(SELF_VERIFY, address(0), 300_000, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, _relay(address(account), _move(0.1 ether)));
        simAddArbitrary(other.sig);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.InvalidPQSignature.selector);
    }

    function test_pathA_executePQSelector_rejected() public {
        _pathA(_execPQ(address(account), _move(0.1 ether)), kat.sig);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.BadFrameShape.selector);
    }

    function testFuzz_pathA_randomWitness_invalid(uint256 seed, uint16 flip) public {
        bytes memory w = bytes.concat(kat.sig);
        uint256 i = bound(flip, 0, 3687);
        w[i] = bytes1(uint8(w[i]) ^ uint8(1 + (seed % 255)));
        _pathA(_relay(address(account), _move(0.1 ether)), w);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(recipient.balance, 0);
    }

    // ------------------------------------------------------------------------------------- construction ------

    function test_constructor_immutables() public view {
        assertEq(signer.account(), address(account));
        assertEq(signer.role(), 1);
        assertEq(address(signer.verifier()), address(verifier));
        assertEq(signer.pk(), kat.pk);
        assertEq(signer.sigLength(), 3688);
        assertEq(signer.payerKey(), payer);
        assertEq(signer.maxFee(), MAX_FEE);
        assertFalse(signer.pathAEnabled());
        assertEq(uint256(signer.feeParam()), uint256(TxParam.MAX_COST));
        assertEq(address(signer.stakingRegistry()), address(registry));
    }

    function test_createRoleSigner_rejectsBadConfig() public {
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        factory.createRoleSigner(bytes32(0), 3, address(account), kat.pk, address(verifier), payer);
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        factory.createRoleSigner(bytes32(0), 1, address(account), kat.pk, makeAddr("noCode"), payer);
        vm.expectRevert(RoleSignerFactory.InvalidConfig.selector);
        factory.createRoleSigner(bytes32(0), 1, address(account), bytes32(0), address(verifier), payer);
        vm.expectRevert(abi.encodeWithSelector(FeeProfile.FeeParamMismatch.selector, 0, 3));
        new PQRoleSigner(Devnet.ERC8421_WORKSHOP, TxParam.MAX_PRIORITY_FEE_PER_GAS, IStakingRegistry(address(registry)));
    }

    // ------------------------------------------------------------------------------- clone / implementation ------

    /// The implementation holds no per-signer args: it can neither approve a frame nor be initialized.
    function test_implementation_refusesToAct() public {
        PQRoleSigner impl = factory.implementation();
        simBegin(address(impl));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), 300_000, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, _relay(address(account), _move(1)));
        simAddArbitrary(kat.sig);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(bytes4(r.frames[0].returnData), PQRoleSigner.NotClone.selector);
        vm.prank(address(factory));
        vm.expectRevert(PQRoleSigner.NotClone.selector);
        impl.initialize(payer, 1);
    }

    /// Only the factory initializes, and only in the creating call (a later call would be a re-initialization).
    function test_initialize_onlyFactory() public {
        vm.expectRevert(PQRoleSigner.NotFactory.selector);
        signer.initialize(address(this), 1);
        vm.prank(makeAddr("frontRunner"));
        vm.expectRevert(PQRoleSigner.NotFactory.selector);
        signer.initialize(address(this), 1);
        assertEq(signer.payerKey(), payer);
    }

    function test_setMaxFee_boundedToUint96() public {
        _pathB(_execPQ(address(signer), abi.encodeCall(PQRoleSigner.setMaxFee, (uint256(type(uint96).max) + 1))));
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.InvalidConfig.selector);
        assertEq(signer.maxFee(), MAX_FEE);
    }

    /// The args are in the clone's code, `payerKey` and `maxFee` share one slot: VERIFY reads one storage slot.
    function test_clone_storageLayout_oneSlot() public view {
        bytes32 slot0 = vm.load(address(signer), bytes32(0));
        assertEq(address(uint160(uint256(slot0))), payer);
        assertEq(uint256(slot0) >> 160, MAX_FEE);
        assertEq(address(signer).code.length, 0x2d + 105);
    }

    // ---------------------------------------------------------------------------------------- unbound mode ------

    function _unbound(uint8 role) internal returns (PQRoleSigner s) {
        s = PQRoleSigner(
            payable(factory.createRoleSigner(bytes32("unbound"), role, address(0), kat.pk, address(verifier), payer))
        );
        vm.deal(address(s), 1 ether);
    }

    function _pathBFrom(PQRoleSigner s, bytes memory body) internal {
        simBegin(address(s));
        simSetFees(1 gwei, 2 gwei, COST);
        simSetSigHash(kat.digest);
        simVerify(SELF_VERIFY, address(0), VERIFY_GAS, abi.encodeCall(PQRoleSigner.verifyFrame, (0)));
        simSender(address(0), SENDER_GAS, 0, body);
        simAddArbitrary(kat.sig);
        simAddSecp256k1(payer);
        simSignSecp256k1(1, payerPk);
    }

    /// An unbound vault signer serves an account whose `getRoles()` names it as the vault.
    function test_unbound_servesAccountThatNamesIt() public {
        MockQueueBitAccount acct = new MockQueueBitAccount();
        vm.deal(address(acct), 1 ether);
        PQRoleSigner s = _unbound(1);
        assertEq(s.account(), address(0));
        acct.setRoles(address(s), address(0), address(0));
        _pathBFrom(s, _execPQ(address(acct), _move(0.1 ether)));
        SimResult memory r = simRunValid();
        _assertVerifyClean(r);
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(recipient.balance, 0.1 ether);
    }

    /// ...and nothing else: not an account that does not name it, not one that names it in the other role, not
    /// an EOA, not a contract without `getRoles`.
    function test_unbound_refusesOtherTargets() public {
        PQRoleSigner s = _unbound(1);
        MockQueueBitAccount stranger = new MockQueueBitAccount();
        stranger.setRoles(makeAddr("otherVault"), address(s), address(0)); // names it as recovery, not vault
        MockOther other = new MockOther();
        address[3] memory targets = [address(stranger), address(other), makeAddr("eoa")];
        for (uint256 i; i < targets.length; i++) {
            _pathBFrom(s, _execPQ(targets[i], _move(0.1 ether)));
            SimResult memory r = simRunValid();
            assertEq(r.frames[1].status, STATUS_FAILED);
            assertEq(bytes4(r.frames[1].returnData), PQRoleSigner.TargetNotAllowed.selector);
        }
        assertEq(recipient.balance, 0);
    }

    function test_unbound_recoveryRole() public {
        PQRoleSigner s = _unbound(2);
        MockQueueBitAccount acct = new MockQueueBitAccount();
        acct.setRoles(makeAddr("vault"), address(s), address(0));
        _pathBFrom(
            s, _execPQ(address(acct), abi.encodeCall(IQueueBitAccountRoles.recoveryCancel, (bytes32(uint256(9)))))
        );
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(acct.lastCancelled(), bytes32(uint256(9)));
    }
}
