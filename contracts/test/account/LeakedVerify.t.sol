// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FrameTxModel} from "../frame/FrameTxModel.sol";
import {ILeakedAccount} from "../../src/account/ILeakedAccount.sol";
import {LeakedAccountImpl} from "../../src/account/LeakedAccountImpl.sol";
import {LeakedAccountRoles} from "../../src/account/LeakedAccountRoles.sol";
import {AccountTestBase} from "./AccountTestBase.sol";

/// FrameSim tests of the hot VERIFY walker (§10.5.1): every accepted shape, and one test per rejection rule.
contract LeakedVerifyTest is AccountTestBase {
    uint256 internal strangerPk = 0xBAD;

    function _pay(uint256 amount) internal view returns (bytes memory) {
        return _hotData(amount, _one(_usdcTransfer(alice, amount)));
    }

    function _expectInvalidVerify(uint256 frame, bytes4 err) internal {
        SimResult memory r = simRun();
        assertFalse(r.valid, "tx should be invalid");
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED), "reason");
        assertEq(r.index, frame, "frame");
        if (err != bytes4(0)) assertEq(bytes4(r.frames[frame].returnData), err, "error selector");
    }

    // ---------------------------------------------------------------------------------- accepted shapes ------

    function test_tankShape_isValidAndPays() public {
        _beginHotTx(_pay(10 * USD));
        _signHotTx();
        uint256 tankBefore = tank.balance;
        SimResult memory r = simRunValid();
        assertEq(r.payer, tank);
        assertEq(r.prefixEnd, 1);
        assertEq(r.frames[2].status, STATUS_SUCCESS);
        assertEq(usdc.balanceOf(alice), 10 * USD);
        assertEq(tank.balance, tankBefore - 0.001 ether);
        FrameTxModel.Approval[] memory a = simApprovals();
        assertEq(a.length, 2);
        assertEq(a[0].target, address(account));
        assertEq(a[0].scope, 2, "I-3: account approves EXECUTION only");
        assertEq(a[1].target, tank);
        assertEq(a[1].scope, 1);
    }

    function test_verifyReadsOnlyOwnStorage_andIsStatic() public {
        _beginHotTx(_pay(10 * USD));
        _signHotTx();
        SimResult memory r = simRunValid();
        assertEq(r.frames[0].foreignSloads, 0, "foreign SLOAD in VERIFY");
        assertEq(r.frames[0].bannedAccesses, 0, r.frames[0].firstBannedAccess);
        assertFalse(r.frames[0].staticViolation);
    }

    function test_selfPayShape_validWhenEnabled() public {
        _queueLoosen(abi.encodeCall(LeakedAccountRoles.vaultSetFeePolicy, (MAX_PRIO, true, tank)));
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(SELF_VERIFY, address(0), 80_000, _verifyData());
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simSignSecp256k1(0, hotPk);
        uint256 before = address(account).balance;
        SimResult memory r = simRunValid();
        assertEq(r.payer, address(account));
        assertEq(address(account).balance, before - 0.001 ether);
        assertEq(simApprovals()[0].scope, 3);
    }

    function test_twoSenderFrames_valid() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simSender(address(0), 300_000, 0, _pay(6 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        simRunValid();
        assertEq(usdc.balanceOf(alice), 11 * USD);
    }

    function test_defaultFrameBefore_isAccepted() public {
        // e.g. a deploy frame ahead of the prefix (the deploy + first hot tx shape).
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simDefault(address(factory), 50_000, "");
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        simRunValid();
    }

    function test_frozen_onlyClearExpiredFreeze_isAdmitted() public {
        vm.prank(guardian);
        roles.guardianFreeze();
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        _beginHotTx(abi.encodeCall(LeakedAccountImpl.clearExpiredFreeze, ()));
        _signHotTx();
        simRunValid();
        assertFalse(account.getHotConfig().hotFrozen);
    }

    // --------------------------------------------------------------------- rejections: one test per rule ------

    function test_rule1_defaultFrameCannotApprove() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simDefault(address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        SimResult memory r = simRun();
        assertFalse(r.valid);
        assertEq(r.frames[0].status, STATUS_FAILED);
        assertEq(bytes4(r.frames[0].returnData), ILeakedAccount.NotVerifyFrame.selector);
    }

    function test_rule1_directCallFromEntryPointHalts() public {
        // Outside a frame transaction the first introspection read halts (the model reverts).
        vm.prank(ENTRY_POINT);
        vm.expectRevert();
        account.verifyFrame();
    }

    function test_rule2_bunker() public {
        vm.prank(vault);
        roles.vaultEnableBunker();
        _beginHotTx(_pay(5 * USD));
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.HotDisabled.selector);
    }

    function test_rule3_wrongSigner() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(vm.addr(strangerPk));
        simAddSecp256k1(tank);
        simSignSecp256k1(0, strangerPk);
        simSignSecp256k1(1, tankPk);
        _expectInvalidVerify(0, ILeakedAccount.BadHotSignature.selector);
    }

    function test_rule3_arbitraryEntryRejectedWithoutHaltingRead() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddArbitrary(hex"0102");
        simAddSecp256k1(tank);
        simSignSecp256k1(1, tankPk);
        // BadHotSignature, not FrameSimHalt: SCHEME is read before RESOLVED_SIGNER.
        _expectInvalidVerify(0, ILeakedAccount.BadHotSignature.selector);
    }

    function test_rule3_explicitMsgDigestRejected() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSig(SCHEME_SECP256K1, hot, keccak256("some other digest"), "");
        simAddSecp256k1(tank);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadHotSignature.selector);
    }

    function test_rule3_tooManySignatures() public {
        _beginHotTx(_pay(5 * USD));
        simAddSecp256k1(tank);
        _signHotTx();
        simSignSecp256k1(2, tankPk);
        _expectInvalidVerify(0, ILeakedAccount.BadSignatureCount.selector);
    }

    function test_rule4_tankLayoutNeedsPayFrame() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadPayFrame.selector);
    }

    function test_rule4_tankLayoutNeedsTwoSignatures() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simSignSecp256k1(0, hotPk);
        _expectInvalidVerify(0, ILeakedAccount.BadPayFrame.selector);
    }

    function test_rule4_payFrameMustBePinnedTank() public {
        uint256 otherPk = 0x0DD;
        address other = vm.addr(otherPk);
        vm.deal(other, 1 ether);
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, other, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(other);
        simSignSecp256k1(0, hotPk);
        simSignSecp256k1(1, otherPk);
        _expectInvalidVerify(0, ILeakedAccount.BadPayFrame.selector);
    }

    function test_rule4_nextFrameMustBePayScope() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(SCOPE_NONE, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadPayFrame.selector);
    }

    function test_rule4_selfPayRefusedUnlessEnabled() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(SELF_VERIFY, address(0), 80_000, _verifyData());
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simSignSecp256k1(0, hotPk);
        _expectInvalidVerify(0, ILeakedAccount.SelfPayDisabled.selector);
    }

    function test_rule4_scopePaymentOnlyRefused() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(PAY, address(0), 80_000, _verifyData());
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simSignSecp256k1(0, hotPk);
        _expectInvalidVerify(0, ILeakedAccount.BadScope.selector);
    }

    function test_rule5_frameCountBound() public {
        _beginHotTx(_pay(1 * USD));
        simSender(address(0), 100_000, 0, _pay(1 * USD));
        simSender(address(0), 100_000, 0, _pay(1 * USD)); // 5 frames > maxHotFrames 4
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.TooManyFrames.selector);
    }

    function test_rule6_senderFrameToOtherTarget() public {
        // C3: a SENDER frame to the hot key's own EOA (or anything but the account) is refused.
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(hot, 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadSenderFrame.selector);
    }

    function test_rule6_senderFrameWithValue() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 1, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadSenderFrame.selector);
    }

    function test_rule6_senderFrameWithScopeFlags() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simAddFrame(MODE_SENDER, PAY, address(0), 300_000, 0, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadSenderFrame.selector);
    }

    function test_rule6_defaultFrameAfterRefused() public {
        _beginHotTx(_pay(5 * USD));
        simDefault(address(account), 50_000, _verifyData());
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadSenderFrame.selector);
    }

    function test_rule6_verifyFrameAfterRefused() public {
        _beginHotTx(_pay(5 * USD));
        simVerify(SCOPE_NONE, address(0), 50_000, _verifyData());
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadSenderFrame.selector);
    }

    function test_rule6_otherSelectorRefused() public {
        _beginHotTx(abi.encodeCall(LeakedAccountRoles.vaultFreeze, ()));
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadSenderFrame.selector);
    }

    function test_rule6_shortDataRefused() public {
        _beginHotTx(abi.encodePacked(LeakedAccountImpl.hotExecute.selector, uint256(1)));
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BadSenderFrame.selector);
    }

    function test_rule6_noSenderFrame() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.NoSenderFrame.selector);
    }

    function test_rule6_declaredOverPerTxMax() public {
        _beginHotTx(_pay(PER_TX + 1));
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.DeclaredOverPerTxMax.selector);
    }

    function test_rule6_declaredSumOverPerTxMax() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(PER_TX / 2 + 1));
        simSender(address(0), 300_000, 0, _pay(PER_TX / 2 + 1));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.DeclaredOverPerTxMax.selector);
    }

    function test_rule7_maxFeeExposure() public {
        _beginHotTx(_pay(5 * USD));
        // MAX_COST (what the payer is charged: maxFeePerGas x (intrinsic + 410k of limits)) = 0.082 ETH > 0.05 bound.
        simSetFees(1 gwei, 200 gwei, 0.082 ether);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.FeeTooHigh.selector);
    }

    function test_rule7_maxPriorityFee() public {
        _beginHotTx(_pay(5 * USD));
        simSetFees(MAX_PRIO + 1, MAX_PRIO + 1, 0.001 ether);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.FeeTooHigh.selector);
    }

    function test_rule7_blobsRefused() public {
        _beginHotTx(_pay(5 * USD));
        sim().setBlobCount(1);
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.BlobsNotAllowed.selector);
    }

    function test_rule8_frozenRefusesHotExecute() public {
        vm.prank(guardian);
        roles.guardianFreeze();
        _beginHotTx(_pay(5 * USD));
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.FrozenOnlyClear.selector);
    }

    function test_rule8_frozenAllowsOnlyOneClearFrame() public {
        vm.prank(guardian);
        roles.guardianFreeze();
        _beginHotTx(abi.encodeCall(LeakedAccountImpl.clearExpiredFreeze, ()));
        simSender(address(0), 100_000, 0, abi.encodeCall(LeakedAccountImpl.clearExpiredFreeze, ()));
        _signHotTx();
        _expectInvalidVerify(0, ILeakedAccount.FrozenOnlyClear.selector);
    }

    function test_rule8_clearBeforeExpiryBurnsOnlyTheTank() public {
        vm.prank(guardian);
        roles.guardianFreeze();
        _beginHotTx(abi.encodeCall(LeakedAccountImpl.clearExpiredFreeze, ()));
        _signHotTx();
        SimResult memory r = simRunValid(); // admitted, then the SENDER frame reverts
        assertEq(r.frames[2].status, STATUS_FAILED);
        assertTrue(account.getHotConfig().hotFrozen);
    }

    function test_frameBefore_withScopeRefused() public {
        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(SCOPE_NONE, address(factory), 10_000, ""); // fine: scope 0 (expiry_verify-like)
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        // frame 0 (scope 0, target without verifyFrame code path) fails the tx on its own; test our rule directly:
        simEnter(1);
        vm.prank(ENTRY_POINT);
        (bool ok,) = address(account).call(_verifyData());
        simLeave(1, ok ? STATUS_SUCCESS : STATUS_FAILED);
        assertTrue(ok, "scope-0 VERIFY before ours is fine");

        simBegin(address(account));
        simSetFees(1 gwei, 1 gwei, 0.001 ether);
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData()); // an approving VERIFY before ours
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        simVerify(PAY, tank, 30_000, "");
        simSender(address(0), 300_000, 0, _pay(5 * USD));
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();
        simEnter(1);
        vm.prank(ENTRY_POINT);
        (bool ok2, bytes memory ret) = address(account).call(_verifyData());
        simLeave(1, STATUS_FAILED);
        assertFalse(ok2);
        assertEq(bytes4(ret), ILeakedAccount.BadFrameBefore.selector);
    }

    function test_overCapPassesVerify_revertsInExecution_tankPays() public {
        // M-b / design: an over-cap batch within perTxMax is admitted; the SENDER frame reverts, only the tank pays.
        _hot(PER_TX, _one(_usdcTransfer(alice, PER_TX)));
        _hot(PER_TX, _one(_usdcTransfer(alice, PER_TX)));
        assertEq(_bucketAvailable(), 0);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 tankBefore = tank.balance;
        _beginHotTx(_pay(100 * USD));
        _signHotTx();
        SimResult memory r = simRunValid();
        assertEq(r.frames[2].status, STATUS_FAILED);
        assertEq(usdc.balanceOf(alice), aliceBefore);
        assertEq(tank.balance, tankBefore - 0.001 ether);
    }

    // ------------------------------------------------------------------------------------------- fuzz ------

    /// Random frame lists: VERIFY approves iff every rule holds (checked against an independent predicate).
    function testFuzz_walkerApprovesIffShapeValid(
        uint8 senderMode,
        bool senderToSelf,
        uint8 senderFlags,
        uint8 value,
        uint8 selPick,
        uint64 declared,
        bool includePay,
        uint8 extraFrames,
        uint64 maxFeeGwei
    ) public {
        senderMode = uint8(bound(senderMode, 0, 2));
        senderFlags = uint8(bound(senderFlags, 0, 7));
        selPick = uint8(bound(selPick, 0, 2));
        extraFrames = uint8(bound(extraFrames, 0, 2));
        maxFeeGwei = uint64(bound(maxFeeGwei, 0, 300));
        value = uint8(bound(value, 0, 1));
        if (senderMode != MODE_SENDER) value = 0; // static constraint of the tx itself
        if (senderFlags & ONLY_VERIFY != 0 && !senderToSelf) senderFlags &= ~ONLY_VERIFY;
        if (senderFlags & ATOMIC_BATCH != 0) senderFlags &= ~ATOMIC_BATCH; // last frame cannot start a batch
        if (senderMode == MODE_VERIFY) senderFlags &= 0x3;

        bytes memory data = selPick == 0
            ? _hotData(declared, _one(_usdcTransfer(alice, 1)))
            : selPick == 1
                ? abi.encodeCall(LeakedAccountImpl.clearExpiredFreeze, ())
                : abi.encodeCall(LeakedAccountRoles.vaultFreeze, ());

        uint256 gasSum = 80_000 + (includePay ? 30_000 : 0) + uint256(extraFrames) * 50_000 + 200_000;
        simBegin(address(account));
        // the devnet's MAX_COST: maxFeePerGas x (limits + intrinsic); 21k of intrinsic gas here
        simSetFees(1 gwei, uint256(maxFeeGwei) * 1 gwei, uint256(maxFeeGwei) * 1 gwei * (gasSum + 21_000));
        simVerify(ONLY_VERIFY, address(0), 80_000, _verifyData());
        if (includePay) simVerify(PAY, tank, 30_000, "");
        address target = senderToSelf ? address(0) : alice;
        for (uint256 k; k < extraFrames; ++k) {
            simSender(address(0), 50_000, 0, _hotData(0, _one(_usdcTransfer(alice, 1))));
        }
        simAddFrame(senderMode, senderFlags, target, 200_000, 0, value, data);
        simAddSecp256k1(hot);
        simAddSecp256k1(tank);
        _signHotTx();

        uint256 n = 1 + (includePay ? 1 : 0) + extraFrames + 1;
        bool expect = includePay && n <= 4 && senderMode == MODE_SENDER && senderToSelf && value == 0
            && (senderFlags & 0x3) == 0 && selPick != 2 && (selPick == 1 || declared <= PER_TX)
            && uint256(maxFeeGwei) * 1 gwei * (gasSum + 21_000) <= MAX_FEE_WEI;

        simEnter(0);
        vm.prank(ENTRY_POINT);
        (bool ok,) = address(account).call(_verifyData());
        simLeave(0, ok ? STATUS_SUCCESS : STATUS_FAILED);
        assertEq(ok, expect);
    }
}
