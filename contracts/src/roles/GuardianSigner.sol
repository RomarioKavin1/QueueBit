// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam, FrameMode, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IQueueBitAccountRoles} from "../interfaces/IQueueBitAccountRoles.sol";
import {FeeProfile} from "./FeeProfile.sol";

/// @title GuardianSigner
/// @notice A freeze-only EIP-8141 sender for a guardian (plan `10-contracts.md` §10.3.7, §10.5.3). Its only power
///         is `account.guardianFreeze()`; the account rate-limits it (one 72 h freeze per 7 days per guardian).
///         Shape: [VERIFY 0x3 (this, verifyFrame()), SENDER(account, guardianFreeze())], signatures
///         [SECP256K1 guardianKey (msg ∅)]. The guardian pays from this contract's balance; `maxFee` bounds it.
/// @dev    ECDSA (SECP256K1) only. A P256 / passkey guardian is the reason this contract exists in the plan, but the
///         chain-1337 devnet and FrameSim do not exercise P256 entries yet; adding it is a second scheme branch here.
///         An ECDSA guardian can equally be a plain EOA sending a type-2 transaction (the account checks msg.sender).
///         All configuration is immutable: to change the key, deploy a new instance and re-register it.
contract GuardianSigner is HegotaSupport {
    uint256 private constant SCHEME_SECP256K1 = 1;

    /// The QueueBit account this guardian may freeze.
    address public immutable account;
    /// The guardian's ECDSA key (signature entry 0).
    address public immutable guardianKey;
    /// Upper bound on `txparam(feeParam)` (wei).
    uint256 public immutable maxFee;
    /// `TxParam.MAX_FEE` (EIP: total budget) or `TxParam.MAX_COST` (ethrex-eip8141-tracer devnet), as `FeeProfile`
    /// requires for the devnet (checked at construction).
    TxParam public immutable feeParam;

    error InvalidConfig();
    error NotVerifyFrame();
    error ScopeNotSelfVerify();
    error BadSignature();
    error BadFrameShape(uint256 frameIndex);
    error FeeTooHigh(uint256 fee, uint256 maxFee);

    constructor(Devnet devnet_, address account_, address guardianKey_, uint256 maxFee_, TxParam feeParam_)
        payable
        HegotaSupport(devnet_)
    {
        if (account_ == address(0) || guardianKey_ == address(0)) revert InvalidConfig();
        FeeProfile.check(devnet_, feeParam_);
        account = account_;
        guardianKey = guardianKey_;
        maxFee = maxFee_;
        feeParam = feeParam_;
    }

    receive() external payable {}

    /// VERIFY entry (frame data = this selector). No storage reads at all: everything is immutable.
    function verifyFrame() external payable {
        uint256 cur = txparam(TxParam.CURRENT_FRAME_INDEX);
        if (frameparam(cur, FrameParam.MODE) != uint256(FrameMode.VERIFY)) revert NotVerifyFrame();
        if (frameparam(cur, FrameParam.ALLOWED_SCOPE) != uint256(Scope.EXECUTION_AND_PAYMENT)) {
            revert ScopeNotSelfVerify();
        }
        if (txparam(TxParam.SIGNATURE_COUNT) != 1) revert BadSignature();
        // Scheme before RESOLVED_SIGNER (the latter halts for an ARBITRARY entry).
        if (sigparam(0, SigParam.SCHEME) != SCHEME_SECP256K1 || sigparam(0, SigParam.MSG) != 0) revert BadSignature();
        if (address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) != guardianKey) revert BadSignature();

        uint256 fee = txparam(feeParam);
        if (fee > maxFee) revert FeeTooHigh(fee, maxFee);

        uint256 i = cur + 1;
        if (txparam(TxParam.FRAME_COUNT) != i + 1) revert BadFrameShape(i);
        if (
            frameparam(i, FrameParam.MODE) != uint256(FrameMode.SENDER)
                || address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET))) != account
                || frameparam(i, FrameParam.VALUE) != 0 || frameparam(i, FrameParam.DATA_LENGTH) != 4
                || bytes4(framedataload(0, i)) != IQueueBitAccountRoles.guardianFreeze.selector
        ) revert BadFrameShape(i);

        approve(Scope.EXECUTION_AND_PAYMENT);
    }
}
