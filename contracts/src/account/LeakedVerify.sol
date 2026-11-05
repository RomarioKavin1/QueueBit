// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam, FrameMode, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {ILeakedAccount} from "./ILeakedAccount.sol";
import {LeakedAccountStorage} from "./LeakedAccountStorage.sol";

/// @title LeakedVerify
/// @notice The hot transaction's VERIFY frame: the frame walker of `docs/plan/sections/10-contracts.md` §10.5.1.
///         Everything reachable from `_verifyHot()` is VERIFY-reachable code and is held to the validation rules of
///         both mempools (EIP-8141 "Public Mempool" trace rules; ERC-8421):
///         - no banned opcode: no TIMESTAMP/NUMBER/BASEFEE/GASPRICE/BALANCE/SELFBALANCE/SSTORE/CREATE*/...;
///         - SLOADs only of the account's own storage (three packed slots of `LeakedAccountStorage`);
///         - CALLs only to the account's own opcode helpers (stateless Yul contracts);
///         - none of the three reads that halt on the devnet (docs/plan/50-devnet-review.md F6-F8):
///           `SIGDATACOPY` (not used at all), `SIGPARAM(j, RESOLVED_SIGNER)` before entry j's scheme is known to be
///           SECP256K1, and `FRAMEPARAM(i, STATUS | EXECUTION_GAS_USED | STATE_GAS_USED)`.
///         `script/lint-verify.sh` enforces this on the compiled bytecode of `VerifyLintTarget` (this contract alone)
///         and on the source; `test/account/VerifyOpcodes.t.sol` re-checks the opcodes actually executed.
/// @dev Shapes accepted (frame `cur` is the account's own VERIFY frame):
///      tank:     [ (DEFAULT | VERIFY scope 0)*, VERIFY(account, only_verify), VERIFY(tank, pay), SENDER(account)+ ]
///                with signatures [SECP256K1 hotKey, SECP256K1 tank]
///      self-pay: [ (DEFAULT | VERIFY scope 0)*, VERIFY(account, self_verify), SENDER(account)+ ]  (vault-enabled)
///                with signatures [SECP256K1 hotKey]
///      Every SENDER frame calls `hotExecute(declaredUsd, calls)` on the account with value 0, or, when the hot tier
///      is frozen, exactly one SENDER frame calls `clearExpiredFreeze()`.
abstract contract LeakedVerify is HegotaSupport, ILeakedAccount {
    uint256 internal constant SCHEME_SECP256K1 = 1;
    bytes4 internal constant HOT_EXECUTE_SELECTOR = 0x7d450a06; // hotExecute(uint256,(address,uint256,bytes)[])
    bytes4 internal constant CLEAR_FREEZE_SELECTOR = 0x1127bd60; // clearExpiredFreeze()

    /// True on profiles where TXPARAM(MAX_FEE) is the per-gas `maxFeePerGas` (the chain-1337 `ethrex-eip8141-tracer`
    /// profile, 50-devnet-review F5): the per-tx bound is then `maxFeePerGas * sum(frame gas limits)`. False where
    /// MAX_FEE is the EIP master's total fee budget (bounded directly). Fixed per implementation (§10 R-5).
    bool internal immutable PER_GAS_MAX_FEE;

    constructor(Devnet devnet, bool perGasMaxFee) HegotaSupport(devnet) {
        PER_GAS_MAX_FEE = perGasMaxFee;
    }

    /// @notice The sole VERIFY entry (frame data = this selector; empty data would run `receive()`).
    /// @dev Approves EXECUTION (tank layout) or EXECUTION_AND_PAYMENT (self-pay layout), or reverts.
    function verifyFrame() external payable {
        _verifyHot();
    }

    function _verifyHot() internal {
        uint256 cur = txparam(TxParam.CURRENT_FRAME_INDEX);
        // Step 1: only a VERIFY frame may approve (a DEFAULT frame is also called by ENTRY_POINT).
        if (frameparam(cur, FrameParam.MODE) != uint256(FrameMode.VERIFY)) revert NotVerifyFrame();

        LeakedAccountStorage.Layout storage $ = LeakedAccountStorage.layout();
        // Step 2: one SLOAD (slot 0): hot key and the vault/guardian-written flags.
        address hotKey = $.hotKey;
        bool frozen = $.hotFrozen;
        if ($.bunker || hotKey == address(0)) revert HotDisabled();

        // Step 3: signature entry 0 is the hot key's SECP256K1 signature over the canonical sig hash. SCHEME is
        // checked before RESOLVED_SIGNER (that read halts for ARBITRARY entries).
        uint256 nsig = txparam(TxParam.SIGNATURE_COUNT);
        if (nsig == 0 || nsig > 2) revert BadSignatureCount(nsig);
        if (sigparam(0, SigParam.SCHEME) != SCHEME_SECP256K1) revert BadHotSignature();
        if (sigparam(0, SigParam.MSG) != 0) revert BadHotSignature();
        if (address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) != hotKey) revert BadHotSignature();

        // Step 5: frame count.
        uint256 n = txparam(TxParam.FRAME_COUNT);
        if (n > $.maxHotFrames) revert TooManyFrames(n, $.maxHotFrames);

        // Step 4: payment layout.
        uint256 allowed = frameparam(cur, FrameParam.ALLOWED_SCOPE);
        uint256 payIdx = type(uint256).max;
        if (allowed == uint256(Scope.EXECUTION)) {
            payIdx = cur + 1;
            if (nsig != 2 || payIdx >= n) revert BadPayFrame();
            if (frameparam(payIdx, FrameParam.MODE) != uint256(FrameMode.VERIFY)) revert BadPayFrame();
            if (frameparam(payIdx, FrameParam.ALLOWED_SCOPE) != uint256(Scope.PAYMENT)) revert BadPayFrame();
            address tank = $.tank; // slot 1
            if (tank != address(0) && address(uint160(frameparam(payIdx, FrameParam.RESOLVED_TARGET))) != tank) {
                revert BadPayFrame();
            }
        } else if (allowed == uint256(Scope.EXECUTION_AND_PAYMENT)) {
            if (!$.selfPay) revert SelfPayDisabled();
            if (nsig != 1) revert BadSignatureCount(nsig);
        } else {
            revert BadScope(allowed);
        }

        // Frames before ours: already run; DEFAULT (e.g. a deploy frame) or VERIFY frames that approve nothing
        // (e.g. expiry_verify). Their gas still counts toward the fee bound below.
        uint256 gasSum;
        for (uint256 i; i < cur; ++i) {
            uint256 mode = frameparam(i, FrameParam.MODE);
            if (mode == uint256(FrameMode.SENDER)) revert BadFrameBefore(i);
            if (mode == uint256(FrameMode.VERIFY) && frameparam(i, FrameParam.ALLOWED_SCOPE) != 0) {
                revert BadFrameBefore(i);
            }
            gasSum += _frameGas(i);
        }
        gasSum += _frameGas(cur);

        // Steps 6 and 8: every later frame (but the pay frame) is a SENDER frame into this account's hot entry.
        uint256 declaredSum;
        uint256 senderFrames;
        for (uint256 i = cur + 1; i < n; ++i) {
            gasSum += _frameGas(i);
            if (i == payIdx) continue;
            if (frameparam(i, FrameParam.MODE) != uint256(FrameMode.SENDER)) revert BadSenderFrame(i);
            if (address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET))) != address(this)) revert BadSenderFrame(i);
            if (frameparam(i, FrameParam.VALUE) != 0) revert BadSenderFrame(i);
            if (frameparam(i, FrameParam.FLAGS) & 0x3 != 0) revert BadSenderFrame(i);
            uint256 len = frameparam(i, FrameParam.DATA_LENGTH);
            if (len < 4) revert BadSenderFrame(i);
            bytes4 sel = bytes4(framedataload(0, i));
            if (frozen) {
                if (sel != CLEAR_FREEZE_SELECTOR) revert FrozenOnlyClear();
            } else if (sel == HOT_EXECUTE_SELECTOR) {
                if (len < 68) revert BadSenderFrame(i);
                declaredSum += uint256(framedataload(4, i));
            } else if (sel != CLEAR_FREEZE_SELECTOR) {
                revert BadSenderFrame(i);
            }
            ++senderFrames;
        }
        if (senderFrames == 0) revert NoSenderFrame();
        if (frozen && senderFrames != 1) revert FrozenOnlyClear();

        // M-b: the static per-tx bound on what the batch may spend (the bucket itself is checked in execution).
        uint256 perTxMax = $.perTxMaxUsd;
        if (declaredSum > perTxMax) revert DeclaredOverPerTxMax(declaredSum, perTxMax);

        // Step 7 (H3): fee exposure. One SLOAD (slot 2).
        uint256 maxFeeWei = $.maxFeeWeiPerTx;
        uint256 maxPrio = $.maxPriorityFeePerGas;
        if (txparam(TxParam.MAX_PRIORITY_FEE_PER_GAS) > maxPrio) revert FeeTooHigh();
        uint256 maxFee = txparam(TxParam.MAX_FEE);
        uint256 exposure = PER_GAS_MAX_FEE ? maxFee * gasSum : maxFee;
        if (exposure > maxFeeWei) revert FeeTooHigh();
        if (txparam(TxParam.BLOB_COUNT) != 0) revert BlobsNotAllowed();

        // Step 9: I-3 - PAYMENT only in the vault-enabled self-pay layout (checked above).
        approve(Scope(allowed));
    }

    /// Execution plus state gas limit of frame `i` (FRAMEPARAM 0x01 and 0x09; both answer for any frame).
    function _frameGas(uint256 i) private view returns (uint256) {
        return frameparam(i, FrameParam.EXECUTION_GAS_LIMIT) + frameparam(i, FrameParam.STATE_GAS_LIMIT);
    }
}
