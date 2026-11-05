// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet, Scope, TxParam, FrameParam, SigParam, FrameMode} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

/// Probe wallet for the LEAKED devnet review: VERIFY checks the protocol-verified secp256k1 signer and reads every
/// introspection opcode (so a wrong opcode byte or id halts the validation frame); the SENDER frame re-reads them in
/// execution and emits the values as events, so the receipt documents what THIS ethrex build answers.
contract OpcodeProbe is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable owner;
    event Word(string name, uint256 value);
    event Bytes(string name, bytes value);

    constructor(address owner_) payable { owner = owner_; }

    /// VERIFY frame entry (data = 0x). Every read here runs inside the validation prefix.
    fallback() external payable {
        require(frameparam(txparam(TxParam.CURRENT_FRAME_INDEX), FrameParam.MODE) == uint256(FrameMode.VERIFY), "not VERIFY");
        require(address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) == owner, "bad signer");
        require(sigparam(0, SigParam.SCHEME) == 1, "scheme");
        require(sigparam(0, SigParam.MSG) == 0, "msg");
        require(txparam(TxParam.SENDER) == uint256(uint160(address(this))), "sender");
        // touch the remaining opcodes so a halt shows up as a prefix failure
        txparam(TxParam.SIG_HASH); txparam(TxParam.FRAME_COUNT); txparam(TxParam.SIGNATURE_COUNT);
        txparam(TxParam.MAX_FEE); txparam(TxParam.NONCE);
        framedataload(0, 1); framedatacopy(0, 4, 1);
        // SIGDATACOPY reverts on a SECP256K1 entry on this ethrex build (bisect 2026-11-06); only ARBITRARY entries copy.
        if (txparam(TxParam.SIGNATURE_COUNT) > 1) sigdatacopy(0, sigparam(1, SigParam.SIGNATURE_LENGTH), 1);
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    /// SENDER frame entry: records what every opcode answers, as events.
    function probe() external {
        require(msg.sender == address(this), "self");
        uint256 cur = txparam(TxParam.CURRENT_FRAME_INDEX);
        emit Word("TXPARAM.TYPE(0x00)", txparam(TxParam.TYPE));
        emit Word("TXPARAM.NONCE(0x01)", txparam(TxParam.NONCE));
        emit Word("TXPARAM.SENDER(0x02)", txparam(TxParam.SENDER));
        emit Word("TXPARAM.MAX_PRIORITY_FEE_PER_GAS(0x03)", txparam(TxParam.MAX_PRIORITY_FEE_PER_GAS));
        emit Word("TXPARAM.MAX_FEE(0x04)", txparam(TxParam.MAX_FEE));
        emit Word("TXPARAM.MAX_COST(0x06)", txparam(TxParam.MAX_COST));
        emit Word("TXPARAM.BLOB_COUNT(0x07)", txparam(TxParam.BLOB_COUNT));
        emit Word("TXPARAM.SIG_HASH(0x08)", txparam(TxParam.SIG_HASH));
        emit Word("TXPARAM.FRAME_COUNT(0x09)", txparam(TxParam.FRAME_COUNT));
        emit Word("TXPARAM.CURRENT_FRAME_INDEX(0x0a)", cur);
        emit Word("TXPARAM.SIGNATURE_COUNT(0x0b)", txparam(TxParam.SIGNATURE_COUNT));
        emit Word("TXPARAM.STATE_GAS_LEFT(0x0c)", txparam(TxParam.STATE_GAS_LEFT));
        emit Word("TXPARAM.LEGACY_NONCE(0x0d)", txparam(TxParam.LEGACY_NONCE));
        emit Word("TXPARAM.NONCE_KEY_COUNT(0x0e)", txparam(TxParam.NONCE_KEY_COUNT));
        emit Word("TXPARAM.NONCE_KEYS_HASH(0x0f)", txparam(TxParam.NONCE_KEYS_HASH));
        emit Word("TXPARAM.NONCE_KEY_0(0x10)", txparam(TxParam.NONCE_KEY_0));
        emit Word("FRAMEPARAM(0,RESOLVED_TARGET)", frameparam(0, FrameParam.RESOLVED_TARGET));
        emit Word("FRAMEPARAM(0,EXECUTION_GAS_LIMIT)", frameparam(0, FrameParam.EXECUTION_GAS_LIMIT));
        emit Word("FRAMEPARAM(0,MODE)", frameparam(0, FrameParam.MODE));
        emit Word("FRAMEPARAM(0,FLAGS)", frameparam(0, FrameParam.FLAGS));
        emit Word("FRAMEPARAM(0,DATA_LENGTH)", frameparam(0, FrameParam.DATA_LENGTH));
        emit Word("FRAMEPARAM(0,ALLOWED_SCOPE)", frameparam(0, FrameParam.ALLOWED_SCOPE));
        emit Word("FRAMEPARAM(0,ATOMIC_BATCH)", frameparam(0, FrameParam.ATOMIC_BATCH));
        emit Word("FRAMEPARAM(0,VALUE)", frameparam(0, FrameParam.VALUE));
        emit Word("FRAMEPARAM(0,STATE_GAS_LIMIT)", frameparam(0, FrameParam.STATE_GAS_LIMIT));
        emit Word("FRAMEPARAM(cur,MODE)", frameparam(cur, FrameParam.MODE));
        emit Word("FRAMEPARAM(cur,RESOLVED_TARGET)", frameparam(cur, FrameParam.RESOLVED_TARGET));
        emit Word("FRAMEPARAM(cur,DATA_LENGTH)", frameparam(cur, FrameParam.DATA_LENGTH));
        emit Word("FRAMEPARAM(cur,VALUE)", frameparam(cur, FrameParam.VALUE));
        emit Word("SIGPARAM(0,RESOLVED_SIGNER)", sigparam(0, SigParam.RESOLVED_SIGNER));
        emit Word("SIGPARAM(0,SCHEME)", sigparam(0, SigParam.SCHEME));
        emit Word("SIGPARAM(0,MSG)", sigparam(0, SigParam.MSG));
        emit Word("SIGPARAM(0,SIGNATURE_LENGTH)", sigparam(0, SigParam.SIGNATURE_LENGTH));
        emit Word("SIGPARAM(1,SCHEME)", sigparam(1, SigParam.SCHEME));
        emit Word("SIGPARAM(1,SIGNATURE_LENGTH)", sigparam(1, SigParam.SIGNATURE_LENGTH));
        emit Word("SIGPARAM(1,MSG)", sigparam(1, SigParam.MSG));
        emit Bytes("FRAMEDATALOAD(0,cur)", abi.encodePacked(framedataload(0, cur)));
        emit Bytes("FRAMEDATACOPY(0,4,cur)", framedatacopy(0, 4, cur));
        emit Bytes("SIGDATACOPY(0,8,1)", sigdatacopy(0, 8, 1));
        emit Bytes("SIGDATACOPY(4,8,1)", sigdatacopy(4, 8, 1));
    }

    /// Reads that revert inside the VERIFY frame on this build (frame 0 = the running frame); here frame 0 is complete.
    function probeRisky() external {
        require(msg.sender == address(this), "self");
        // Both halt with "invalid opcode" on this build (2026-11-06): RESOLVED_SIGNER of an ARBITRARY entry with an empty
        // signer, and SIGDATACOPY of a SECP256K1 entry. A halt burns ALL gas forwarded to the helper.
        emit Word("SIGPARAM(1,RESOLVED_SIGNER) arbitrary/empty signer", sigparam(1, SigParam.RESOLVED_SIGNER));
        emit Bytes("SIGDATACOPY(0,65,0) secp256k1 entry", sigdatacopy(0, 65, 0));
    }

    // NOTE: deliberately no receive(): with one, a VERIFY frame whose data is 0x would run receive() instead of
    // fallback() and never APPROVE ("validation prefix did not establish a payer"). Plan §10 item 9 confirmed live.
}
