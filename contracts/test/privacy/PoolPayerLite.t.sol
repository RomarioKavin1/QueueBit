// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolPayer} from "../../src/privacy/PoolPayer.sol";
import {PoolPayerLite} from "../../src/privacy/PoolPayerLite.sol";
import {PrivacyPoolsTypes} from "../../src/privacy/IPrivacyPools.sol";
import {PoolPayerBase} from "./PoolPayerBase.sol";
import {PoolPayerFixtures as Fx} from "./fixtures/PoolPayerFixtures.sol";

/// PoolPayerLite: the cheap `pay` VERIFY frame that fits the public sidecars' MAX_VERIFY_GAS (100k for the whole
/// validation prefix, signature costs included). Same fixtures as `PoolPayer.t.sol`, deployed at the same address.
contract PoolPayerLiteTest is PoolPayerBase {
    uint256 internal constant FEE = 0.01 ether;
    /// EIP-8141 MAX_VERIFY_GAS as the stock sidecar enforces it (validationPrefix.ts), and the SECP256K1 entry cost
    /// it adds to the prefix's `limits.execution`.
    uint64 internal constant MAX_VERIFY_GAS = 100_000;
    uint64 internal constant SECP256K1_COST = 2_800;
    /// The prefix the devnet scripts send: only_verify (default code: ~100 gas on ethrex) + pay.
    uint64 internal constant ONLY_VERIFY_GAS = 5_000;
    uint64 internal constant LITE_PAY_GAS = MAX_VERIFY_GAS - SECP256K1_COST - ONLY_VERIFY_GAS;

    function _deployPayer(PoolPayer.Config memory c) internal override returns (PoolPayer) {
        return new PoolPayerLite(c);
    }

    /// [only_verify 5k, pay 92.2k, settle, refund]: the prefix budget the public sidecar admits, enforced.
    function _buildLiteTx(PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) internal {
        _buildLiteTxMaxCost(w, p, MAX_COST);
    }

    function _buildLiteTxMaxCost(
        PrivacyPoolsTypes.Withdrawal memory w,
        PrivacyPoolsTypes.WithdrawProof memory p,
        uint256 maxCost
    ) internal {
        simBegin(sender);
        simSetFees(1 gwei, 2 gwei, maxCost);
        simAddFrame(MODE_VERIFY, ONLY_VERIFY, address(0), ONLY_VERIFY_GAS, 0, 0, "");
        simAddFrame(
            MODE_VERIFY, PAY, address(payer), LITE_PAY_GAS, PAY_STATE, 0, _verifyData(w, p, Fx.STATE_ROOT_INDEX)
        );
        simAddFrame(MODE_DEFAULT, 0, address(payer), SETTLE_GAS, SETTLE_STATE, 0, abi.encodeCall(PoolPayer.settle, (1)));
        simAddFrame(MODE_DEFAULT, 0, address(payer), REFUND_GAS, REFUND_STATE, 0, abi.encodeCall(PoolPayer.refund, ()));
        simAddSecp256k1(address(0));
        simSignSecp256k1(0, senderPk);
    }

    function _expectVerifyRevert(bytes memory expected) internal {
        uint256 before = address(payer).balance;
        SimResult memory r = simRun();
        assertFalse(r.valid, "tx must be invalid");
        assertEq(uint256(r.reason), uint256(InvalidReason.VERIFY_FAILED));
        assertEq(r.index, 1);
        assertEq(r.frames[1].returnData, expected);
        assertEq(address(payer).balance, before, "an invalid tx costs PoolPayerLite nothing");
    }

    // ------------------------------------------------------------------------------------------ happy path ------

    /// A valid withdrawal with the prefix limits the public sidecar admits (FrameSim runs frames with all gas: its
    /// mocks over-count, see `test_lite_gas_verify`).
    function test_lite_withdraw_withinPrefixBudget() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        assertLe(ONLY_VERIFY_GAS + LITE_PAY_GAS + SECP256K1_COST, MAX_VERIFY_GAS, "prefix fits MAX_VERIFY_GAS");
        _buildLiteTx(w, p);
        uint256 payerBefore = address(payer).balance;
        SimResult memory r = simRunValid();

        assertEq(r.payer, address(payer));
        for (uint256 f; f < 4; f++) {
            assertEq(r.frames[f].status, STATUS_SUCCESS);
        }
        assertFalse(r.frames[1].staticViolation);
        assertEq(r.frames[1].bannedAccesses, 0, r.frames[1].firstBannedAccess);
        assertGt(r.frames[1].foreignSloads, 0); // pool + Entrypoint reads: STORAGE-033, staked payer
        assertTrue(pool.nullifierHashes(Fx.NULLIFIER_HASH_1), "note spent: the proof was checked by pool.withdraw");
        assertGt(sender.balance, Fx.WITHDRAWN - FEE, "recipient = withdrawn - fee + refund");
        assertLt(address(payer).balance, payerBefore - MAX_COST + FEE, "PoolPayerLite keeps at most the cost");
    }

    /// VERIFY gas. FrameSim cannot give the on-chain total: every introspection read and the APPROVE are mock calls
    /// into the model contract (thousands of gas each, APPROVE writes the model's storage), so they dominate its
    /// number. What it measures exactly is the part of `verify` between the frame-shape checks and APPROVE (decode,
    /// context hash, the pool and Entrypoint SLOADs, plus one mock read for the quote): a run that fails at the last
    /// check (FeeBelowQuote) minus a run that fails at the first one after the shape (InvalidProcessooor). The
    /// authoritative total is the devnet's (`ethrex_simulateFrameTransaction` per-frame gas, recorded by
    /// contracts/devnet-tests/privacy/src/public-lite.ts).
    function test_lite_gas_verify() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildLiteTxMaxCost(w, p, FEE + 1); // every check runs, the last one (the quote) fails: no APPROVE
        SimResult memory allChecks = simRun();
        assertEq(allChecks.frames[1].returnData, abi.encodeWithSelector(PoolPayer.FeeBelowQuote.selector, FEE, FEE + 1));

        _buildLiteTx(PrivacyPoolsTypes.Withdrawal(bob, w.data), p); // stops right after the frame-shape checks
        SimResult memory shapeOnly = simRun();
        assertEq(shapeOnly.frames[1].returnData, abi.encodeWithSelector(PoolPayer.InvalidProcessooor.selector));

        _buildLiteTx(w, p); // last: it spends the note
        SimResult memory full = simRunValid();

        uint256 checks = allChecks.frames[1].gasUsed - shapeOnly.frames[1].gasUsed;
        emit log_named_uint("verify frame, FrameSim total (mock-inflated)", full.frames[1].gasUsed);
        emit log_named_uint("verify between the shape checks and APPROVE (pool/ASP/fee/context)", checks);
        // The Groth16 check alone is ~243k (PoolPayer.t.sol test_gas_verify); what Lite runs instead must stay a
        // small part of the pay frame's 92.2k.
        assertLt(checks, 40_000, "cheap checks stay cheap");
    }

    // ------------------------------------------------------------------------------------- rejections ------

    function test_lite_reject_feeRecipientNotPayer() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        PoolPayer.FeeData memory f = abi.decode(w.data, (PoolPayer.FeeData));
        f.feeRecipient = bob;
        w.data = abi.encode(f);
        _buildLiteTx(w, p);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.InvalidFeeData.selector));
    }

    function test_lite_reject_recipientIsPayer() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        PoolPayer.FeeData memory f = abi.decode(w.data, (PoolPayer.FeeData));
        f.recipient = address(payer);
        w.data = abi.encode(f);
        _buildLiteTx(w, p);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.InvalidFeeData.selector));
    }

    /// Swapping the recipient (or the fee) breaks the context the proof's public signal commits to: caught in VERIFY
    /// without the proof check.
    function test_lite_reject_wrongRecipient_contextMismatch() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        PoolPayer.FeeData memory f = abi.decode(w.data, (PoolPayer.FeeData));
        f.recipient = bob;
        w.data = abi.encode(f);
        _buildLiteTx(w, p);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.ContextMismatch.selector));
    }

    function test_lite_reject_wrongFee_contextMismatch() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        PoolPayer.FeeData memory f = abi.decode(w.data, (PoolPayer.FeeData));
        f.fee -= 1;
        w.data = abi.encode(f);
        _buildLiteTx(w, p);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.ContextMismatch.selector));
    }

    function test_lite_reject_spentNullifier() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildLiteTx(w, p);
        simRunValid();
        (w, p) = Fx.toBob(); // same note, another valid proof
        _buildLiteTx(w, p);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.NullifierSpent.selector));
    }

    function test_lite_reject_feeBelowQuote() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildLiteTxMaxCost(w, p, FEE + 1);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.FeeBelowQuote.selector, FEE, FEE + 1));
    }

    function test_lite_reject_staleASPRoot() public {
        vm.prank(postman);
        entrypoint.updateRoot(Fx.ASP_ROOT + 1, CID);
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        _buildLiteTx(w, p);
        _expectVerifyRevert(abi.encodeWithSelector(PoolPayer.StaleASPRoot.selector));
    }

    // ------------------------------------------------------------------------------------- the trade-off ------

    /// An invalid proof is NOT caught in VERIFY: PoolPayerLite approves, `pool.withdraw` rejects the proof in the
    /// settle frame, the note stays unspent, nothing moves to the recipient, and PoolPayerLite pays the gas.
    function test_lite_invalidProof_paysGasButMovesNothing() public {
        (PrivacyPoolsTypes.Withdrawal memory w, PrivacyPoolsTypes.WithdrawProof memory p) = _good();
        p.pA[0] = p.pA[0] ^ 1;
        _buildLiteTx(w, p);
        uint256 payerBefore = address(payer).balance;
        SimResult memory r = simRunValid();
        assertEq(r.payer, address(payer), "approved without the proof");
        assertEq(r.frames[1].status, STATUS_SUCCESS);
        assertEq(r.frames[2].status, STATUS_FAILED, "settle reverts in pool.withdraw (invalid proof)");
        assertEq(r.frames[3].status, STATUS_SUCCESS, "refund is a no-op");
        assertFalse(pool.nullifierHashes(Fx.NULLIFIER_HASH_1), "note not spent");
        assertEq(sender.balance, 0, "nothing paid out");
        // Sim: APPROVE debits max_cost; on chain the charge is the gas actually used (the griefing cost).
        assertEq(address(payer).balance, payerBefore - MAX_COST, "PoolPayerLite pays, collects no fee");
    }
}
