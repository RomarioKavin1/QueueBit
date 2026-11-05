// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {TxParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {FrameTxModel} from "../frame/FrameTxModel.sol";
import {PoolPayer} from "../../src/privacy/PoolPayer.sol";
import {PrivacyPoolsTypes} from "../../src/privacy/IPrivacyPools.sol";
import {PoolPayerBase} from "./PoolPayerBase.sol";
import {PoolPayerFixtures as Fx} from "./fixtures/PoolPayerFixtures.sol";

contract PoolPayerTest is PoolPayerBase {
    uint256 internal constant FEE = 0.01 ether;

    // ----------------------------------------------------------------------------------------- happy path ------

    function test_withdraw_endToEnd() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        uint256 payerBefore = address(payer).balance;
        SimResult memory r = simRunValid();

        assertEq(r.payer, address(payer), "PoolPayer is the payer");
        assertEq(r.prefixEnd, 1);
        for (uint256 f; f < 4; f++) {
            assertEq(r.frames[f].status, STATUS_SUCCESS);
        }
        // VERIFY stays static and touches nothing the mempool bans that FrameSim can see.
        assertFalse(r.frames[1].staticViolation);
        assertEq(r.frames[1].bannedAccesses, 0, r.frames[1].firstBannedAccess);
        assertGt(r.frames[1].foreignSloads, 0); // pool + Entrypoint reads: STORAGE-032, staked payer

        assertTrue(pool.nullifierHashes(Fx.NULLIFIER_HASH_1), "note spent");
        uint256 refund = _referenceRefund(r, FEE);
        assertGt(refund, 0);
        assertEq(sender.balance, Fx.WITHDRAWN - FEE + refund, "recipient = withdrawn - fee + refund");
        // Sim: APPROVE debited max_cost (the protocol's end-of-tx refund of max_cost - actual is not modelled).
        assertEq(address(payer).balance, payerBefore - MAX_COST + FEE - refund, "PoolPayer keeps only cost");
        assertEq(payer.totalClaimable(), 0);
        assertEq(payer.pendingSig(), ~sim().sigHash(), "refund consumed");
    }

    function test_tailCalls_allowedWhenRecipientIsSender() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.tailFrames = 2;
        _buildTx(w, p, s);
        SimResult memory r = simRunValid();
        assertEq(r.frames[5].status, STATUS_SUCCESS);
        assertGt(sender.balance, Fx.WITHDRAWN - FEE);
    }

    // ------------------------------------------------------------------------------ verify(): rejections ------

    function _expectVerifyRevert(bytes memory expected) internal {
        SimResult memory r = simRun();
        assertFalse(r.valid, "tx must be invalid");
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED));
        assertEq(r.index, 1);
        assertEq(r.frames[1].returnData, expected);
        assertEq(address(payer).balance, FLOAT, "an invalid tx costs PoolPayer nothing");
    }

    function test_reject_wrongContext() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        // A different fee than the one the proof's context commits to.
        PoolPayer.FeeData memory f = abi.decode(w.data, (PoolPayer.FeeData));
        f.fee += 1;
        w.data = abi.encode(f);
        _buildTx(w, p, _shape());
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.ContextMismatch.selector));
    }

    function test_reject_spentNullifier() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        simRunValid();
        // Same note, another valid proof (different fee data / recipient).
        (w, p) = Fx.toBob();
        _buildTx(w, p, _shape());
        _expectVerifyRevertFrom(abi.encodeWithSelector(PoolPayer.NullifierSpent.selector), address(payer).balance);
    }

    function test_reject_wrongStateRoot() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.rootIndexHint = Fx.STATE_ROOT_INDEX - 1; // the root after the first deposit only
        _buildTx(w, p, s);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.UnknownStateRoot.selector));
    }

    function test_reject_rootNotInPool() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        p.pubSignals[3] = 12345;
        _buildTx(w, p, _shape());
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.UnknownStateRoot.selector));
    }

    function test_reject_staleASPRoot() public {
        vm.prank(postman);
        entrypoint.updateRoot(Fx.ASP_ROOT + 1, CID);
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.StaleASPRoot.selector));
    }

    function test_reject_feeAboveWithdrawnValue() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = Fx.feeTooHigh();
        _buildTx(w, p, _shape());
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.FeeExceedsWithdrawal.selector));
    }

    function test_reject_feeBelowQuote() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.maxCost = FEE + 1;
        _buildTx(w, p, s);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.FeeBelowQuote.selector, FEE, FEE + 1));
    }

    function test_reject_invalidProof() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        p.pA[0] = p.pA[0] ^ 1;
        _buildTx(w, p, _shape());
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.InvalidProof.selector));
    }

    function test_reject_tamperedWithdrawnValue() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        p.pubSignals[2] = Fx.NOTE_VALUE; // claim the whole note: the proof no longer verifies
        _buildTx(w, p, _shape());
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.InvalidProof.selector));
    }

    function test_reject_wrongNextFrameData_settleIndex() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.settleArg = 0;
        _buildTx(w, p, s);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(2)));
    }

    function test_reject_wrongNextFrameData_selector() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        simBegin(sender);
        simSetFees(1 gwei, 2 gwei, MAX_COST);
        simAddFrame(MODE_VERIFY, ONLY_VERIFY, address(0), 10_000, 0, 0, "");
        simAddFrame(MODE_VERIFY, PAY, address(payer), PAY_GAS, PAY_STATE, 0, _verifyData(w, p, Fx.STATE_ROOT_INDEX));
        simAddFrame(MODE_DEFAULT, 0, address(payer), SETTLE_GAS, SETTLE_STATE, 0, abi.encodeCall(PoolPayer.refund, ()));
        simAddFrame(MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ()));
        simAddSecp256k1(address(0));
        simSignSecp256k1(0, senderPk);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(2)));
    }

    function test_reject_starvedSettleFrame() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.settleGas = SETTLE_GAS - 1; // would let a user make settle run out of gas at PoolPayer's expense
        _buildTx(w, p, s);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(2)));
    }

    function test_reject_missingRefundFrame() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.withRefund = false;
        _buildTx(w, p, s);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(3)));
    }

    function test_reject_refundNotLast() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        // append a SENDER frame after refund(): the last frame is no longer refund()
        sim().pushFrame(FrameTxModel.Frame(MODE_SENDER, 0, makeAddr("dapp"), 50_000, 0, 0, hex"01"));
        simSignSecp256k1(0, senderPk); // the sig hash covers the frames
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(4)));
    }

    function test_reject_starvedRefundFrame() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.refundGas = REFUND_GAS - 1;
        _buildTx(w, p, s);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(3)));
    }

    function test_reject_payFrameWithoutStateGas() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.payState = 0; // APPROVE could not create the fresh sender account
        _buildTx(w, p, s);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(1)));
    }

    function test_reject_tailCallsWhenRecipientIsNotSender() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = Fx.toBob();
        Shape memory s = _shape();
        s.tailFrames = 1;
        _buildTx(w, p, s);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.TailCallsNeedRecipientSender.selector));
    }

    function test_reject_wrongScope() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        simBegin(sender);
        simSetFees(1 gwei, 2 gwei, MAX_COST);
        simAddFrame(MODE_VERIFY, ONLY_VERIFY, address(0), 10_000, 0, 0, "");
        simAddFrame(
            MODE_VERIFY,
            PAY,
            address(payer),
            PAY_GAS,
            PAY_STATE,
            0,
            abi.encodeCall(PoolPayer.verify, (Fx.SCOPE + 1, w, p, Fx.STATE_ROOT_INDEX))
        );
        simAddFrame(MODE_DEFAULT, 0, address(payer), SETTLE_GAS, SETTLE_STATE, 0, abi.encodeCall(PoolPayer.settle, (1)));
        simAddFrame(MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ()));
        simAddSecp256k1(address(0));
        simSignSecp256k1(0, senderPk);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.PoolNotFound.selector));
    }

    function _expectVerifyRevertFrom(bytes memory expected, uint256 balance) internal {
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(r.index, 1);
        assertEq(r.frames[1].returnData, expected);
        assertEq(address(payer).balance, balance);
    }

    // ---------------------------------------------------------------------------------- settle(): binding ------

    function test_settle_outsideFrameTx_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(FrameTxModel.FrameSimHalt.selector, "introspection outside a frame transaction")
        );
        payer.settle(1);
    }

    /// A transaction that someone else pays for cannot make PoolPayer withdraw (and so take a fee or pay anything).
    function test_settle_notPayer_rejected() public {
        (address tank, uint256 tankPk) = makeAddrAndKey("tank");
        vm.deal(tank, 1 ether);
        simBegin(sender);
        simSetFees(1 gwei, 2 gwei, MAX_COST);
        simAddFrame(MODE_VERIFY, ONLY_VERIFY, address(0), 10_000, 0, 0, "");
        simAddFrame(MODE_VERIFY, PAY, tank, 10_000, PAY_STATE, 0, "");
        simAddFrame(MODE_DEFAULT, 0, address(payer), SETTLE_GAS, SETTLE_STATE, 0, abi.encodeCall(PoolPayer.settle, (1)));
        simAddSecp256k1(address(0));
        simAddSecp256k1(tank);
        simSignSecp256k1(0, senderPk);
        simSignSecp256k1(1, tankPk);
        SimResult memory r = simRunValid();
        assertEq(r.payer, tank);
        assertEq(r.frames[2].status, STATUS_FAILED);
        assertEq(r.frames[2].returnData, abi.encodeWithSelector(PoolPayer.NotPoolPayerTx.selector));
        assertFalse(pool.nullifierHashes(Fx.NULLIFIER_HASH_1));
    }

    /// settle() must name the frame right before it; pointing at an earlier VERIFY frame is rejected.
    function test_settle_mustBeRightAfterVerify() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        simEnter(2);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(PoolPayer.NotPoolPayerTx.selector);
        payer.settle(0);
        simLeave(2, STATUS_FAILED);
    }

    /// The arguments come from the VERIFY frame: settle has no calldata to tamper with, and the bytes it reads are
    /// exactly the ones `verify` checked (a second settle in the same tx is refused).
    function test_settle_oncePerTx() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        simRunValid();
        // Re-enter frame 2 of the same (already executed) tx: same sig hash.
        simEnter(2);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(PoolPayer.AlreadySettled.selector);
        payer.settle(1);
        simLeave(2, STATUS_FAILED);
    }

    function test_refund_mustBeLastFrame() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        simEnter(2);
        vm.prank(ENTRY_POINT);
        vm.expectRevert(PoolPayer.NotLastFrame.selector);
        payer.refund();
        simLeave(2, STATUS_FAILED);
    }

    /// refund() in an unrelated transaction pays nothing.
    function test_refund_otherTx_noop() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        simRunValid();
        uint256 bal = address(payer).balance;
        (address tank, uint256 tankPk) = makeAddrAndKey("tank");
        vm.deal(tank, 1 ether);
        simBegin(tank);
        simSetFees(1 gwei, 2 gwei, MAX_COST);
        simAddFrame(MODE_VERIFY, SELF_VERIFY, address(0), 10_000, 0, 0, "");
        simAddFrame(MODE_DEFAULT, 0, address(payer), REFUND_GAS, 0, 0, abi.encodeCall(PoolPayer.refund, ()));
        simAddSecp256k1(address(0));
        simSignSecp256k1(0, tankPk);
        SimResult memory r = simRunValid();
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(address(payer).balance, bal);
    }

    // ----------------------------------------------------------------------------------- refund(): math ------

    /// Independent re-statement of the estimator, from the simulator's own frame records.
    function _referenceRefund(SimResult memory r, uint256 fee) internal returns (uint256) {
        FrameTxModel m = sim();
        uint256 n = m.frameCount();
        uint256 gas = 15_000 + n * 475 + 30_000;
        for (uint256 f; f < n; f++) {
            FrameTxModel.Frame memory fr = m.frameAt(f);
            gas += fr.data.length * 4;
            if (fr.value > 0 && m.resolvedTarget(f) != sender) gas += 6_000; // TX_VALUE_COST
            if (f < n - 1) gas += r.frames[f].gasUsed; // state gas is not metered by the simulator (reports 0)
        }
        uint256 cost = gas * GAS_PRICE;
        return fee > cost ? fee - cost : 0;
    }

    function test_refund_matchesReference() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        vm.recordLogs();
        SimResult memory r = simRunValid();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 expected = _referenceRefund(r, FEE);
        bool seen;
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].topics[0] == PoolPayer.Refunded.selector) {
                (uint256 amount, uint256 cost) = abi.decode(logs[k].data, (uint256, uint256));
                assertEq(amount, expected, "refund == reference");
                assertEq(amount + cost, FEE, "refund + cost == fee");
                assertEq(address(uint160(uint256(logs[k].topics[2]))), sender);
                seen = true;
            }
        }
        assertTrue(seen, "Refunded emitted");
    }

    function testFuzz_refund_neverExceedsFee(uint64 gasPriceGwei) public {
        uint256 gp = bound(uint256(gasPriceGwei), 1, 10_000) * 1 gwei;
        vm.txGasPrice(gp);
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        SimResult memory r = simRunValid();
        uint256 cost;
        {
            FrameTxModel m = sim();
            uint256 n = m.frameCount();
            uint256 gas = 15_000 + n * 475 + 30_000;
            for (uint256 f; f < n; f++) {
                gas += m.frameAt(f).data.length * 4;
                if (f < n - 1) gas += r.frames[f].gasUsed;
            }
            cost = gas * gp;
        }
        uint256 refund = FEE > cost ? FEE - cost : 0;
        assertEq(sender.balance, Fx.WITHDRAWN - FEE + refund);
        assertLe(refund, FEE);
    }

    function test_refund_toRefundRecipient() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = Fx.toBob();
        _buildTx(w, p, _shape());
        SimResult memory r = simRunValid();
        assertEq(bob.balance, Fx.WITHDRAWN - FEE, "recipient gets withdrawn - fee");
        assertEq(sender.balance, _referenceRefund(r, FEE), "refund to refundRecipient");
    }

    // ------------------------------------------------------------------------------------------ griefing ------

    /// §2.2 cause 2 / R14: a recipient whose receive() reverts cannot make settle revert. The withdrawal completes,
    /// the note is spent, the payout is credited; the same note cannot be used again, so PoolPayer is not drained.
    function test_griefing_revertingRecipient_cannotRepeat() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = Fx.griefer();
        _buildTx(w, p, _shape());
        uint256 before = address(payer).balance;
        SimResult memory r = simRunValid();
        assertEq(r.frames[2].status, STATUS_SUCCESS, "settle succeeds despite the reverting recipient");
        assertEq(r.frames[3].status, STATUS_SUCCESS);
        assertTrue(pool.nullifierHashes(Fx.NULLIFIER_HASH_1), "note spent: the attack consumed it");
        uint256 refund = _referenceRefund(r, FEE);
        assertEq(payer.claimable(address(griefer)), Fx.WITHDRAWN - FEE + refund);
        assertEq(payer.totalClaimable(), Fx.WITHDRAWN - FEE + refund);
        // PoolPayer's own float moved by exactly what it would have for an honest recipient.
        assertEq(address(payer).balance - payer.totalClaimable(), before - MAX_COST + FEE - refund);

        // Replay with the same proof: invalid at VERIFY, so it costs PoolPayer nothing.
        uint256 bal = address(payer).balance;
        _buildTx(w, p, _shape());
        _expectVerifyRevertFrom(abi.encodeWithSelector(PoolPayer.NullifierSpent.selector), bal);

        // The griefer can still pull its money to another address.
        address payable sink = payable(makeAddr("sink"));
        griefer.claimTo(payer, sink);
        assertEq(sink.balance, Fx.WITHDRAWN - FEE + refund);
        assertEq(payer.totalClaimable(), 0);
        vm.expectRevert(PoolPayer.NothingToClaim.selector);
        griefer.claimTo(payer, sink);
    }

    function test_withdrawFloat_cannotTouchCredits() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = Fx.griefer();
        _buildTx(w, p, _shape());
        simRunValid();
        uint256 float = address(payer).balance - payer.totalClaimable();
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(PoolPayer.ExceedsFloat.selector, float + 1, float));
        payer.withdrawFloat(payable(operator), float + 1);
        vm.prank(operator);
        payer.withdrawFloat(payable(operator), float);
        assertEq(address(payer).balance, payer.totalClaimable());
    }

    // ----------------------------------------------------------------------------------- staking / admin ------

    function test_stake_operatorOnly() public {
        vm.deal(operator, 1 ether);
        vm.prank(operator);
        payer.stake{value: 0.012 ether}(86_400);
        (uint256 st, uint32 delay,) = registry.getDepositInfo(address(payer));
        assertEq(st, 0.012 ether);
        assertEq(delay, 86_400);

        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(PoolPayer.NotOperator.selector);
        payer.stake{value: 0.012 ether}(86_400);
        vm.prank(bob);
        vm.expectRevert(PoolPayer.NotOperator.selector);
        payer.unlockStake();
        vm.prank(bob);
        vm.expectRevert(PoolPayer.NotOperator.selector);
        payer.withdrawStake(payable(bob));

        vm.startPrank(operator);
        payer.unlockStake();
        payer.withdrawStake(payable(operator));
        vm.stopPrank();
        assertEq(operator.balance, 1 ether);
    }

    function test_setOperator() public {
        vm.prank(bob);
        vm.expectRevert(PoolPayer.NotOperator.selector);
        payer.setOperator(bob);
        vm.prank(operator);
        payer.setOperator(bob);
        assertEq(payer.operator(), bob);
    }

    function test_config_capsEnforceAtCost() public {
        PoolPayer.Config memory c = _config();
        c.intrinsicGas = uint64(payer.MAX_INTRINSIC_GAS() + 1);
        vm.expectRevert(PoolPayer.InvalidConfig.selector);
        new PoolPayer(c);
        c = _config();
        c.gasPerDataByte = 5;
        vm.expectRevert(PoolPayer.InvalidConfig.selector);
        new PoolPayer(c);
        c = _config();
        c.refundFrameGas = uint64(payer.MAX_REFUND_FRAME_GAS() + 1);
        vm.expectRevert(PoolPayer.InvalidConfig.selector);
        new PoolPayer(c);
        c = _config();
        c.valueFrameGas = uint64(payer.MAX_VALUE_FRAME_GAS() + 1);
        vm.expectRevert(PoolPayer.InvalidConfig.selector);
        new PoolPayer(c);
        c = _config();
        c.feeParam = TxParam.SENDER;
        vm.expectRevert(PoolPayer.InvalidConfig.selector);
        new PoolPayer(c);
    }

    function test_quote_isOneToOne() public view {
        assertEq(payer.quote(123), 123);
    }

    // ------------------------------------------------------------------------------------------- gas report ------

    /// The Groth16 check alone (real precompile costs); the VERIFY-frame total in FrameSim is inflated by the mock
    /// helpers (a model call per introspection read), the devnet number is authoritative (IMPLEMENTATION-NOTES).
    function test_gas_verify() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        uint256 g0 = gasleft();
        bool ok = verifier.verifyProof(p.pA, p.pB, p.pC, p.pubSignals);
        uint256 proofGas = g0 - gasleft();
        assertTrue(ok);
        _buildTx(w, p, _shape());
        SimResult memory r = simRunValid();
        emit log_named_uint("groth16 verifyProof (external call)", proofGas);
        emit log_named_uint("verify frame, FrameSim (mock helpers)", r.frames[1].gasUsed);
        emit log_named_uint("settle frame, FrameSim", r.frames[2].gasUsed);
        emit log_named_uint("refund frame, FrameSim", r.frames[3].gasUsed);
        assertLt(proofGas, 300_000, "proof check fits the 300k verify target");
    }

    // ------------------------------------------------------------------------------------- audit PoCs ------

    /// A failed atomic batch whose terminator is refund() skips refund(): the user's refund is stranded in
    /// `pendingFee` and, since it is not in `totalClaimable`, the operator can sweep it with `withdrawFloat`.
    function test_audit_atomicBatchBeforeRefund_strandsRefund() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.withRefund = false;
        _buildTx(w, p, s);
        // [.., settle(1), SENDER tail (ATOMIC_BATCH, reverts), refund()] -- refund() is the batch terminator.
        sim().pushFrame(FrameTxModel.Frame(MODE_SENDER, ATOMIC_BATCH, address(griefer), 50_000, 0, 0, hex"01"));
        sim().pushFrame(
            FrameTxModel.Frame(
                MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ())
            )
        );
        simSignSecp256k1(0, senderPk);
        SimResult memory r = simRun();
        if (r.valid) {
            // PRE-FIX behaviour (documented by this branch): the tx is valid, refund() was skipped, money stranded.
            assertEq(r.frames[4].status, STATUS_SKIPPED, "refund skipped by the failed batch");
            assertEq(payer.pendingSig(), sim().sigHash(), "refund never consumed");
            assertEq(sender.balance, Fx.WITHDRAWN - FEE, "no refund");
            uint256 float = address(payer).balance - payer.totalClaimable();
            vm.prank(operator);
            payer.withdrawFloat(payable(operator), float); // includes the user's unrefunded fee
            fail("pre-fix: a failed atomic batch strands the refund in the operator's float");
        }
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED));
        assertEq(r.frames[1].returnData, abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(3)));
    }

    /// Blob gas is charged to the payer but priced in neither GASPRICE nor costEstimate: v1 refuses blob txs.
    function test_audit_blobTx_rejected() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildTx(w, p, _shape());
        sim().setBlobCount(1);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BlobsNotAllowed.selector));
    }

    /// Calldata is charged 16 gas per non-zero byte (and 64 per byte when the EIP-7976 floor binds) but estimated at 4:
    /// every byte the user can add beyond the fixed shape is PoolPayer's loss. The pay frame is pinned to the exact
    /// encoding; trailing bytes (ignored by the ABI decoder) are rejected.
    function test_audit_payFrameTrailingBytes_rejected() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        bytes memory data = _verifyData(w, p, Fx.STATE_ROOT_INDEX);
        assertEq(data.length, payer.VERIFY_DATA_LENGTH(), "canonical pay-frame length");
        simBegin(sender);
        simSetFees(1 gwei, 2 gwei, MAX_COST);
        simAddFrame(MODE_VERIFY, ONLY_VERIFY, address(0), 10_000, 0, 0, "");
        simAddFrame(MODE_VERIFY, PAY, address(payer), PAY_GAS, PAY_STATE, 0, bytes.concat(data, new bytes(4000)));
        simAddFrame(MODE_DEFAULT, 0, address(payer), SETTLE_GAS, SETTLE_STATE, 0, abi.encodeCall(PoolPayer.settle, (1)));
        simAddFrame(MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ()));
        simAddSecp256k1(address(0));
        simSignSecp256k1(0, senderPk);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.BadFrameShape.selector, uint256(1)));
    }

    function test_audit_tailFrameData_capped() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        uint256 cap = payer.MAX_UNPRICED_DATA_BYTES();
        Shape memory s = _shape();
        s.withRefund = false;
        _buildTx(w, p, s);
        sim().pushFrame(FrameTxModel.Frame(MODE_SENDER, 0, makeAddr("dapp"), 50_000, 0, 0, new bytes(cap + 1)));
        sim().pushFrame(
            FrameTxModel.Frame(
                MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ())
            )
        );
        simSignSecp256k1(0, senderPk);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.TooMuchUnpricedData.selector, cap + 1));

        // At the cap: accepted.
        _buildTx(w, p, s);
        sim().pushFrame(FrameTxModel.Frame(MODE_SENDER, 0, makeAddr("dapp"), 50_000, 0, 0, new bytes(cap)));
        sim().pushFrame(
            FrameTxModel.Frame(
                MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ())
            )
        );
        simSignSecp256k1(0, senderPk);
        SimResult memory r = simRunValid();
        assertEq(r.frames[4].status, STATUS_SUCCESS);
    }

    /// Frames before the pay frame (expiry / deploy / pre_verify) count against the same cap.
    function test_audit_prefixFrameData_capped() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        uint256 cap = payer.MAX_UNPRICED_DATA_BYTES();
        simBegin(sender);
        simSetFees(1 gwei, 2 gwei, MAX_COST);
        simAddFrame(MODE_VERIFY, ONLY_VERIFY, address(0), 10_000, 0, 0, new bytes(cap + 1)); // default code ignores data
        simAddFrame(MODE_VERIFY, PAY, address(payer), PAY_GAS, PAY_STATE, 0, _verifyData(w, p, Fx.STATE_ROOT_INDEX));
        simAddFrame(MODE_DEFAULT, 0, address(payer), SETTLE_GAS, SETTLE_STATE, 0, abi.encodeCall(PoolPayer.settle, (1)));
        simAddFrame(MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ()));
        simAddSecp256k1(address(0));
        simSignSecp256k1(0, senderPk);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.TooMuchUnpricedData.selector, cap + 1));
    }

    /// ARBITRARY signature witnesses are charged 16 gas/byte and never estimated; signature entries cost
    /// verification gas (2,800 / 6,700) the estimator does not see either.
    function test_audit_signatures_capped() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        uint256 cap = payer.MAX_UNPRICED_DATA_BYTES();
        _buildTx(w, p, _shape());
        simAddArbitrary(new bytes(cap + 1));
        simSignSecp256k1(0, senderPk);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.TooMuchUnpricedData.selector, cap + 1));

        _buildTx(w, p, _shape());
        for (uint256 k; k < payer.MAX_SIGNATURES(); k++) {
            simAddArbitrary(hex"01");
        }
        simSignSecp256k1(0, senderPk);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.TooManySignatures.selector));
    }

    /// A value-carrying tail frame costs TX_VALUE_COST of intrinsic gas: priced by the estimator.
    function test_audit_valueTailFrame_priced() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        Shape memory s = _shape();
        s.withRefund = false;
        _buildTx(w, p, s);
        sim().pushFrame(FrameTxModel.Frame(MODE_SENDER, 0, makeAddr("dapp"), 50_000, 0, 1 wei, hex""));
        sim().pushFrame(
            FrameTxModel.Frame(
                MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ())
            )
        );
        simSignSecp256k1(0, senderPk);
        SimResult memory r = simRunValid();
        uint256 refund = _referenceRefund(r, FEE);
        assertEq(sender.balance, Fx.WITHDRAWN - FEE + refund - 1 wei);
        assertEq(makeAddr("dapp").balance, 1 wei);
    }

    /// Paying the withdrawal or the refund to PoolPayer itself would turn user money into operator float.
    function test_audit_recipientIsPoolPayer_rejected() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        PoolPayer.FeeData memory f = abi.decode(w.data, (PoolPayer.FeeData));
        f.recipient = address(payer);
        w.data = abi.encode(f);
        _buildTx(w, p, _shape());
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.InvalidFeeData.selector));
    }

    /// A receiver that burns all forwarded gas (not just reverts) gets its payout and its refund as credits; the
    /// frames still succeed and the note is spent.
    function test_audit_gasHungryReceiver_credited() public {
        vm.etch(Fx.GRIEFER, address(new GasBurner()).code);
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = Fx.griefer();
        _buildTx(w, p, _shape());
        SimResult memory r = simRunValid();
        assertEq(r.frames[2].status, STATUS_SUCCESS);
        assertEq(r.frames[3].status, STATUS_SUCCESS);
        uint256 refund = _referenceRefund(r, FEE);
        assertEq(payer.claimable(Fx.GRIEFER), Fx.WITHDRAWN - FEE + refund);
        assertEq(payer.pendingSig(), ~sim().sigHash(), "refund consumed");
    }
}

/// A receiver whose receive() burns every unit of gas it is given.
contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}
