// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {Opcode} from "@forshtat/hegota-support/contracts/Opcode.sol";
import {Scope, TxParam, FrameParam, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FrameSim} from "./FrameSim.sol";
import {FrameTxModel} from "./FrameTxModel.sol";
import {SimWallet, SimPaymaster, Foreign} from "./SimContracts.sol";

contract FrameSimTest is FrameSim {
    uint256 internal ownerKey = 0xA11CE;
    uint256 internal tankKey = 0x7A4C;
    uint256 internal strangerKey = 0xBAD;
    address internal owner;
    address internal tank;
    address internal stranger;
    address internal recipient = address(0xBEEF);

    SimWallet internal wallet;

    function setUp() public {
        owner = vm.addr(ownerKey);
        tank = vm.addr(tankKey);
        stranger = vm.addr(strangerKey);
        wallet = new SimWallet{value: 10 ether}(owner);
        simAttach(address(wallet));
        vm.deal(tank, 1 ether);
    }

    // ------------------------------------------------------------------------------------------- helpers ------

    function _selfRelay(bytes memory verifyData, bytes memory body) internal {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, verifyData);
        simSender(address(0), 200_000, 0, body);
        simAddSecp256k1(owner);
        simSignSecp256k1(0, ownerKey);
    }

    function _bump() internal pure returns (bytes memory) {
        return abi.encodeCall(SimWallet.bump, ());
    }

    function _verify() internal pure returns (bytes memory) {
        return abi.encodeCall(SimWallet.verifyFrame, ());
    }

    // ------------------------------------------------------------------------------------- self relay ------

    function test_selfVerifyTransactionIsValid() public {
        uint256 nonceBefore = vm.getNonce(address(wallet));
        _selfRelay(_verify(), _bump());
        SimResult memory r = simRunValid();
        assertEq(r.payer, address(wallet));
        assertEq(r.prefixEnd, 0);
        assertEq(r.frames[0].status, STATUS_SUCCESS);
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(wallet.counter(), 1);
        assertEq(vm.getNonce(address(wallet)), nonceBefore + 1);
        FrameTxModel.Approval[] memory a = simApprovals();
        assertEq(a.length, 1);
        assertEq(a[0].target, address(wallet));
        assertEq(a[0].scope, 3);
    }

    function test_helperNonceIsTheAccountsDeployNonce() public view {
        // 7 helpers created by the constructor: the account's nonce starts at 8 (§10.1.1).
        assertEq(vm.getNonce(address(wallet)), 8);
    }

    function test_signatureByAnotherKeyIsRejectedByVerify() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simSender(address(0), 200_000, 0, _bump());
        simAddSecp256k1(stranger);
        simSignSecp256k1(0, strangerKey);
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED));
        assertEq(r.index, 0);
        assertEq(bytes4(r.frames[0].returnData), SimWallet.NotOwnerSignature.selector);
        assertEq(wallet.counter(), 0);
    }

    function test_forgedSignatureMakesTheTransactionInvalid() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simAddSecp256k1(owner);
        simSignSecp256k1(0, strangerKey); // claims owner, signed by stranger
        SimResult memory r = simRun();
        assertEq(uint256(r.reason), uint256(InvalidReason.BAD_SIGNATURE));
        assertEq(r.frames[0].status, STATUS_NOT_RUN);
    }

    function test_highSAndBadVAreRejected() public {
        _selfRelay(_verify(), _bump());
        bytes memory good = sim().sigAt(0).signature;
        bytes memory badV = good;
        badV[0] = bytes1(uint8(27));
        simSetSignature(0, badV);
        assertEq(uint256(simRun().reason), uint256(InvalidReason.BAD_SIGNATURE));
        simSetSignature(0, hex"00");
        assertEq(uint256(simRun().reason), uint256(InvalidReason.BAD_SIGNATURE));
    }

    function test_nonceMismatchIsInvalid() public {
        _selfRelay(_verify(), _bump());
        simSetNonce(1);
        assertEq(uint256(simRun().reason), uint256(InvalidReason.NONCE_MISMATCH));
    }

    // --------------------------------------------------- hot shape: only_verify + default-code tank pay ------

    function test_onlyVerifyThenDefaultCodeTankPays() public {
        simBegin(address(wallet));
        simSetFees(1 gwei, 0.01 ether, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verify());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 200_000, 0, _bump());
        simAddSecp256k1(owner);
        simAddSecp256k1(tank);
        simSignSecp256k1(0, ownerKey);
        simSignSecp256k1(1, tankKey);
        uint256 walletBalance = address(wallet).balance;

        SimResult memory r = simRunValid();
        assertEq(r.payer, tank);
        assertEq(r.prefixEnd, 1);
        assertEq(tank.balance, 1 ether - 0.001 ether);
        assertEq(address(wallet).balance, walletBalance);
        assertEq(wallet.counter(), 1);
        FrameTxModel.Approval[] memory a = simApprovals();
        assertEq(a.length, 2);
        assertEq(a[0].scope, 2);
        assertEq(a[1].target, tank);
        assertEq(a[1].scope, 1);
    }

    function test_payBeforeSenderApprovalFails() public {
        simBegin(address(wallet));
        simVerify(PAY, tank, 30_000, "");
        simVerify(ONLY_VERIFY, address(0), 80_000, _verify());
        simAddSecp256k1(owner);
        simAddSecp256k1(tank);
        simSignSecp256k1(0, ownerKey);
        simSignSecp256k1(1, tankKey);
        SimResult memory r = simRun();
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED));
        assertEq(r.index, 0);
    }

    function test_defaultCodeNeedsItsOwnSignatureAtIndexOne() public {
        simBegin(address(wallet));
        simVerify(ONLY_VERIFY, address(0), 80_000, _verify());
        simVerify(PAY, tank, 30_000, "");
        simAddSecp256k1(owner);
        simAddSecp256k1(stranger);
        simSignSecp256k1(0, ownerKey);
        simSignSecp256k1(1, strangerKey);
        SimResult memory r = simRun();
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED));
        assertEq(r.index, 1);
    }

    function test_defaultCodePayerWithoutBalanceFails() public {
        simBegin(address(wallet));
        simSetFees(0, 0, 2 ether); // more than the tank holds
        simVerify(ONLY_VERIFY, address(0), 80_000, _verify());
        simVerify(PAY, tank, 30_000, "");
        simAddSecp256k1(owner);
        simAddSecp256k1(tank);
        simSignSecp256k1(0, ownerKey);
        simSignSecp256k1(1, tankKey);
        assertEq(uint256(simRun().reason), uint256(InvalidReason.VERIFY_FAILED));
    }

    function test_contractPaymasterPays() public {
        SimPaymaster pm = new SimPaymaster{value: 1 ether}();
        simAttach(address(pm));
        simBegin(address(wallet));
        simSetFees(0, 0, 0.5 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verify());
        simVerify(PAY, address(pm), 50_000, abi.encodeCall(SimPaymaster.verifyFrame, ()));
        simSender(address(0), 200_000, 0, _bump());
        simAddSecp256k1(owner);
        simSignSecp256k1(0, ownerKey);
        SimResult memory r = simRunValid();
        assertEq(r.payer, address(pm));
        assertEq(address(pm).balance, 0.5 ether);
    }

    function test_noPayerIsInvalid() public {
        simBegin(address(wallet));
        simVerify(ONLY_VERIFY, address(0), 80_000, _verify());
        simSender(address(0), 200_000, 0, _bump());
        simAddSecp256k1(owner);
        simSignSecp256k1(0, ownerKey);
        SimResult memory r = simRun();
        assertEq(uint256(r.reason), uint256(InvalidReason.NO_PAYER));
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(wallet.counter(), 0, "an invalid transaction leaves no state");
    }

    function test_senderFrameBeforeApprovalIsInvalid() public {
        simBegin(address(wallet));
        simSender(address(0), 200_000, 0, _bump());
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simAddSecp256k1(owner);
        simSignSecp256k1(0, ownerKey);
        SimResult memory r = simRun();
        assertEq(uint256(r.reason), uint256(InvalidReason.SENDER_NOT_APPROVED));
        assertEq(r.index, 0);
    }

    // -------------------------------------------------------------------------------- APPROVE rules ------

    function test_approveOutsideTheFramesScopeReverts() public {
        // An only_verify frame: approving both scopes is not allowed.
        simBegin(address(wallet));
        simVerify(
            ONLY_VERIFY, address(0), 100_000, abi.encodeCall(SimWallet.verifyWithScope, (Scope.EXECUTION_AND_PAYMENT))
        );
        FrameOutcome memory o = simRunFrame(0);
        assertEq(o.status, STATUS_FAILED);
        assertEq(
            o.returnData,
            abi.encodeWithSelector(FrameTxModel.ApproveReverted.selector, "scope not allowed by frame.flags")
        );
    }

    function test_approveNoneReverts() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, abi.encodeCall(SimWallet.verifyWithScope, (Scope.NONE)));
        assertEq(simRunFrame(0).status, STATUS_FAILED);
    }

    function test_secondApprovalReverts() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, abi.encodeCall(SimWallet.approveTwice, ()));
        FrameOutcome memory o = simRunFrame(0);
        assertEq(o.status, STATUS_FAILED);
        assertEq(o.returnData, abi.encodeWithSelector(FrameTxModel.ApproveReverted.selector, "sender already approved"));
        assertFalse(sim().senderApproved(), "a reverted frame discards its approval");
    }

    function test_executionApprovalByNonSenderReverts() public {
        SimPaymaster pm = new SimPaymaster();
        simAttach(address(pm));
        simBegin(address(wallet));
        // The static constraint forbids this frame in a real transaction; run the frame alone to hit APPROVE's check.
        simVerify(SELF_VERIFY, address(wallet), 100_000, abi.encodeCall(SimWallet.verifyWithScope, (Scope.EXECUTION)));
        simVerify(PAY, address(pm), 100_000, abi.encodeCall(SimPaymaster.verifyFrame, ()));
        assertEq(simRunFrame(1).status, STATUS_FAILED, "PAYMENT before the sender is approved");
    }

    function test_approveIsCalledFromTheAccountItself() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simEnter(0);
        vm.expectRevert(abi.encodeWithSelector(FrameTxModel.ApproveReverted.selector, "ADDRESS != resolved_target"));
        sim().approve(3);
    }

    // ------------------------------------------------------------------------ VERIFY is a STATICCALL ------

    function test_verifyThatWritesStorageIsInvalid() public {
        _selfRelay(abi.encodeCall(SimWallet.verifyAndWrite, ()), _bump());
        SimResult memory r = simRun();
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_NOT_STATIC));
        assertTrue(r.frames[0].staticViolation);
        assertEq(wallet.counter(), 0);
    }

    function test_foreignStorageReadIsReported() public {
        Foreign f = new Foreign();
        _selfRelay(abi.encodeCall(SimWallet.verifyReadingForeign, (f)), _bump());
        SimResult memory r = simRunValid();
        assertEq(r.frames[0].foreignSloads, 1);
        assertEq(r.frames[0].firstForeignAccount, address(f));
        assertEq(r.frames[0].firstForeignSlot, bytes32(0));
    }

    function test_ownStorageReadIsNotForeign() public {
        _selfRelay(_verify(), _bump());
        SimResult memory r = simRunValid();
        assertEq(r.frames[0].foreignSloads, 0);
    }

    // ---------------------------------------------------------------------------- ARBITRARY witness ------

    function test_arbitraryWitnessOverTheSigHash() public {
        simBegin(address(wallet));
        simSetSigHash(keccak256("tx"));
        simVerify(SELF_VERIFY, address(0), 100_000, abi.encodeCall(SimWallet.verifyArbitrary, ()));
        simSender(address(0), 200_000, 0, _bump());
        simAddArbitrary(abi.encode(keccak256("tx"), owner));
        simRunValid();
        assertEq(wallet.counter(), 1);
    }

    function test_arbitraryWitnessForAnotherHashFails() public {
        simBegin(address(wallet));
        simSetSigHash(keccak256("tx"));
        simVerify(SELF_VERIFY, address(0), 100_000, abi.encodeCall(SimWallet.verifyArbitrary, ()));
        simAddArbitrary(abi.encode(keccak256("other"), owner));
        SimResult memory r = simRun();
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED));
        assertEq(bytes4(r.frames[0].returnData), SimWallet.BadWitness.selector);
    }

    // ----------------------------------------------------------------------------- frame walking ------

    function test_walkerSeesTheNextFrame() public {
        bytes memory exec = abi.encodeCall(SimWallet.execute, (recipient, 1 ether, ""));
        _selfRelay(abi.encodeCall(SimWallet.verifyWalk, ()), exec);
        simRunValid();
        assertEq(recipient.balance, 1 ether);
    }

    function test_walkerRejectsAnotherSelector() public {
        _selfRelay(abi.encodeCall(SimWallet.verifyWalk, ()), _bump());
        SimResult memory r = simRun();
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED));
        assertEq(bytes4(r.frames[0].returnData), SimWallet.BadNextFrame.selector);
    }

    function test_senderFrameCarriesValueFromTheSender() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simSender(recipient, 50_000, 2 ether, "");
        simAddSecp256k1(owner);
        simSignSecp256k1(0, ownerKey);
        simRunValid();
        assertEq(recipient.balance, 2 ether);
        assertEq(address(wallet).balance, 8 ether);
    }

    function test_senderFrameIsCalledBySenderAndVerifyByEntryPoint() public {
        _selfRelay(_verify(), abi.encodeCall(SimWallet.execute, (recipient, 0, "")));
        simRunValid(); // execute() requires msg.sender == wallet
        // A DEFAULT frame calls as ENTRY_POINT, so execute() reverts there.
        simBegin(address(wallet));
        simDefault(address(0), 100_000, abi.encodeCall(SimWallet.execute, (recipient, 0, "")));
        FrameOutcome memory o = simRunFrame(0);
        assertEq(o.status, STATUS_FAILED);
        assertEq(bytes4(o.returnData), SimWallet.NotSelf.selector);
    }

    // ------------------------------------------------------------------------------ atomic batches ------

    function test_failedAtomicBatchRollsBackItsFrames() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simAddFrame(MODE_SENDER, ATOMIC_BATCH, address(0), 100_000, 0, 0, _bump());
        simSender(address(0), 100_000, 0, abi.encodeCall(SimWallet.failing, ()));
        simSender(address(0), 100_000, 0, _bump());
        simAddSecp256k1(owner);
        simSignSecp256k1(0, ownerKey);
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(r.frames[2].status, STATUS_FAILED);
        assertEq(r.frames[3].status, STATUS_SUCCESS);
        assertEq(wallet.counter(), 1, "frame 1's bump was rolled back with the batch");
        assertEq(sim().statusOf(1), STATUS_SUCCESS);
    }

    function test_framesAfterTheFailureInABatchAreSkipped() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simAddFrame(MODE_SENDER, ATOMIC_BATCH, address(0), 100_000, 0, 0, _bump());
        simAddFrame(MODE_SENDER, ATOMIC_BATCH, address(0), 100_000, 0, 0, abi.encodeCall(SimWallet.failing, ()));
        simSender(address(0), 100_000, 0, _bump());
        simAddSecp256k1(owner);
        simSignSecp256k1(0, ownerKey);
        SimResult memory r = simRunValid();
        assertEq(r.frames[2].status, STATUS_FAILED);
        assertEq(r.frames[3].status, STATUS_SKIPPED);
        assertEq(sim().statusOf(3), STATUS_SKIPPED);
        assertEq(wallet.counter(), 0);
    }

    // ------------------------------------------------------------------------- static constraints ------

    function test_staticConstraints() public {
        // value on a VERIFY frame
        simBegin(address(wallet));
        simAddFrame(MODE_VERIFY, SELF_VERIFY, address(0), 100_000, 0, 1, _verify());
        assertEq(uint256(simRun().reason), uint256(InvalidReason.STATIC_CONSTRAINT));
        // execution approval on a frame that targets someone else
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, tank, 100_000, "");
        assertEq(uint256(simRun().reason), uint256(InvalidReason.STATIC_CONSTRAINT));
        // atomic batch flag on the last frame
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simAddFrame(MODE_SENDER, ATOMIC_BATCH, address(0), 100_000, 0, 0, _bump());
        assertEq(uint256(simRun().reason), uint256(InvalidReason.STATIC_CONSTRAINT));
        // an approval scope inside a batch
        simBegin(address(wallet));
        simAddFrame(MODE_SENDER, ATOMIC_BATCH | PAY, address(0), 100_000, 0, 0, _bump());
        simSender(address(0), 100_000, 0, _bump());
        assertEq(uint256(simRun().reason), uint256(InvalidReason.STATIC_CONSTRAINT));
        // flags >= 8, unknown mode, no frames, ARBITRARY with a signer
        simBegin(address(wallet));
        simAddFrame(MODE_SENDER, 8, address(0), 100_000, 0, 0, "");
        assertEq(uint256(simRun().reason), uint256(InvalidReason.STATIC_CONSTRAINT));
        simBegin(address(wallet));
        simAddFrame(3, 0, address(0), 100_000, 0, 0, "");
        assertEq(uint256(simRun().reason), uint256(InvalidReason.STATIC_CONSTRAINT));
        simBegin(address(wallet));
        assertEq(uint256(simRun().reason), uint256(InvalidReason.STATIC_CONSTRAINT));
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simAddSig(SCHEME_ARBITRARY, owner, bytes32(0), "");
        assertEq(uint256(simRun().reason), uint256(InvalidReason.STATIC_CONSTRAINT));
    }

    // ----------------------------------------------------------------------------- introspection ------

    function test_txParams() public {
        simBegin(address(wallet));
        simSetFees(3 gwei, 0.02 ether, 0.01 ether);
        simSetSigHash(keccak256("h"));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simSender(address(0), 200_000, 0, _bump());
        simAddSecp256k1(owner);
        simEnter(1);
        assertEq(wallet.tp(TxParam.TYPE), 6);
        assertEq(wallet.tp(TxParam.NONCE), 8);
        assertEq(wallet.tp(TxParam.SENDER), uint256(uint160(address(wallet))));
        assertEq(wallet.tp(TxParam.MAX_PRIORITY_FEE_PER_GAS), 3 gwei);
        assertEq(wallet.tp(TxParam.MAX_FEE), 0.02 ether);
        assertEq(wallet.tp(TxParam.MAX_COST), 0.01 ether);
        assertEq(wallet.tp(TxParam.BLOB_COUNT), 0);
        assertEq(bytes32(wallet.tp(TxParam.SIG_HASH)), keccak256("h"));
        assertEq(wallet.tp(TxParam.FRAME_COUNT), 2);
        assertEq(wallet.tp(TxParam.CURRENT_FRAME_INDEX), 1);
        assertEq(wallet.tp(TxParam.SIGNATURE_COUNT), 1);
        vm.expectRevert(abi.encodeWithSelector(FrameTxModel.FrameSimHalt.selector, "TXPARAM: undefined param"));
        wallet.tp(TxParam.UNASSIGNED_05);
    }

    function test_frameParams() public {
        simBegin(address(wallet));
        simVerify(ONLY_VERIFY, address(0), 80_000, _verify());
        simAddFrame(MODE_SENDER, ATOMIC_BATCH, recipient, 50_000, 7_000, 5, hex"aabbcc");
        simSender(address(0), 200_000, 0, _bump());
        simEnter(2);
        sim().leave(0, STATUS_SUCCESS, 1234);
        simEnter(2);
        assertEq(wallet.fp(0, FrameParam.RESOLVED_TARGET), uint256(uint160(address(wallet))));
        assertEq(wallet.fp(1, FrameParam.RESOLVED_TARGET), uint256(uint160(recipient)));
        assertEq(wallet.fp(1, FrameParam.EXECUTION_GAS_LIMIT), 50_000);
        assertEq(wallet.fp(1, FrameParam.MODE), MODE_SENDER);
        assertEq(wallet.fp(0, FrameParam.FLAGS), ONLY_VERIFY);
        assertEq(wallet.fp(1, FrameParam.DATA_LENGTH), 3);
        assertEq(wallet.fp(0, FrameParam.STATUS), STATUS_SUCCESS);
        assertEq(wallet.fp(0, FrameParam.ALLOWED_SCOPE), 2);
        assertEq(wallet.fp(1, FrameParam.ATOMIC_BATCH), 1);
        assertEq(wallet.fp(0, FrameParam.ATOMIC_BATCH), 0);
        assertEq(wallet.fp(1, FrameParam.VALUE), 5);
        assertEq(wallet.fp(1, FrameParam.STATE_GAS_LIMIT), 7_000);
        assertEq(wallet.fp(0, FrameParam.EXECUTION_GAS_USED), 1234);
        assertEq(wallet.fp(0, FrameParam.STATE_GAS_USED), 0);
        vm.expectRevert(
            abi.encodeWithSelector(
                FrameTxModel.FrameSimHalt.selector, "FRAMEPARAM: status/gas of the current or a later frame"
            )
        );
        wallet.fp(2, FrameParam.STATUS);
        vm.expectRevert(abi.encodeWithSelector(FrameTxModel.FrameSimHalt.selector, "frame index out of bounds"));
        wallet.fp(3, FrameParam.MODE);
    }

    function test_frameDataLoadAndCopyPadWithZeros() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, hex"0102030405");
        simEnter(0);
        assertEq(wallet.fdl(0, 0), bytes32(hex"0102030405"));
        assertEq(wallet.fdl(3, 0), bytes32(hex"0405"));
        assertEq(wallet.fdl(100, 0), bytes32(0));
        assertEq(wallet.fdl(type(uint256).max, 0), bytes32(0));
        assertEq(wallet.fdc(1, 6, 0), hex"020304050000");
        assertEq(wallet.fdc(0, 0, 0), "");
    }

    function test_sigParamsAndSigDataCopy() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simAddArbitrary(hex"c0ffee");
        simAddSecp256k1(address(0));
        simAddSig(SCHEME_SECP256K1, owner, keccak256("explicit"), "");
        simEnter(0);
        assertEq(wallet.sp(0, SigParam.SCHEME), SCHEME_ARBITRARY);
        assertEq(wallet.sp(0, SigParam.SIGNATURE_LENGTH), 3);
        assertEq(wallet.sp(0, SigParam.MSG), 0);
        assertEq(wallet.sdc(0, 4, 0), hex"c0ffee00");
        assertEq(wallet.sp(1, SigParam.RESOLVED_SIGNER), uint256(uint160(address(wallet))), "empty signer = sender");
        assertEq(wallet.sp(2, SigParam.RESOLVED_SIGNER), uint256(uint160(owner)));
        assertEq(bytes32(wallet.sp(2, SigParam.MSG)), keccak256("explicit"));
        vm.expectRevert(
            abi.encodeWithSelector(
                FrameTxModel.FrameSimHalt.selector, "SIGPARAM: RESOLVED_SIGNER of an ARBITRARY entry"
            )
        );
        wallet.sp(0, SigParam.RESOLVED_SIGNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                FrameTxModel.FrameSimHalt.selector, "SIGPARAM: SIGNATURE_LENGTH of a validated scheme"
            )
        );
        wallet.sp(1, SigParam.SIGNATURE_LENGTH);
        vm.expectRevert(
            abi.encodeWithSelector(FrameTxModel.FrameSimHalt.selector, "SIGDATACOPY: not an ARBITRARY entry")
        );
        wallet.sdc(0, 1, 1);
        vm.expectRevert(abi.encodeWithSelector(FrameTxModel.FrameSimHalt.selector, "signature index out of bounds"));
        wallet.sp(3, SigParam.SCHEME);
    }

    function test_introspectionOutsideAFrameHalts() public {
        simBegin(address(wallet));
        vm.expectRevert(
            abi.encodeWithSelector(FrameTxModel.FrameSimHalt.selector, "introspection outside a frame transaction")
        );
        wallet.tp(TxParam.TYPE);
        vm.expectRevert(
            abi.encodeWithSelector(FrameTxModel.FrameSimHalt.selector, "APPROVE outside a frame transaction")
        );
        wallet.verifyWithScope(Scope.EXECUTION);
    }

    function test_keyedNonceParamsAreNotModelled() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 100_000, _verify());
        simEnter(0);
        vm.expectRevert(
            abi.encodeWithSelector(FrameTxModel.FrameSimUnsupported.selector, "TXPARAM (EIP-8250 keyed nonce)", 0x0e)
        );
        wallet.tp(TxParam.NONCE_KEY_COUNT);
    }

    function test_modelIsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(FrameTxModel.NotOwner.selector);
        sim().reset();
    }

    function test_gasLimitsAreEnforcedOnlyWhenAskedTo() public {
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 5_000, _verify());
        simAddSecp256k1(owner);
        assertEq(simRunFrame(0).status, STATUS_SUCCESS);
        simBegin(address(wallet));
        simVerify(SELF_VERIFY, address(0), 5_000, _verify());
        simAddSecp256k1(owner);
        simEnforceGasLimits(true);
        assertEq(simRunFrame(0).status, STATUS_FAILED);
    }

    // ------------------------------------------------------------------------------ helper layout ------

    function test_helperAddressesFollowTheDevnetsOpcodeSet() public pure {
        address a = address(0x1234);
        assertEq(simHelperAddress(a, Devnet.ERC8421_WORKSHOP, Opcode.Approve), vm.computeCreateAddress(a, 1));
        assertEq(simHelperAddress(a, Devnet.ERC8421_WORKSHOP, Opcode.SigParam), vm.computeCreateAddress(a, 6));
        assertEq(simHelperAddress(a, Devnet.ERC8421_WORKSHOP, Opcode.SigDataCopy), vm.computeCreateAddress(a, 7));
        assertEq(simHelperAddress(a, Devnet.ERC8421_WORKSHOP, Opcode.TxTrace), address(0));
        // The EIP-7906 devnet has no SIGDATACOPY, so TXTRACE is its 7th helper.
        assertEq(simHelperAddress(a, Devnet.EIP7906_WORKSHOP, Opcode.SigDataCopy), address(0));
        assertEq(simHelperAddress(a, Devnet.EIP7906_WORKSHOP, Opcode.TxTrace), vm.computeCreateAddress(a, 7));
    }

    function test_attachedMocksReplaceTheRealHelpers() public view {
        address approveHelper = simHelperAddress(address(wallet), Devnet.ERC8421_WORKSHOP, Opcode.Approve);
        assertTrue(keccak256(approveHelper.code) != keccak256(hex"600035600080aa"));
        assertGt(approveHelper.code.length, 7);
    }
}
