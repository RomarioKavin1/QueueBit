// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet, Scope, TxParam, FrameParam, SigParam, FrameMode} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";

/// Bisecting probe: the VERIFY frame's first data byte selects ONE introspection read to perform before APPROVE,
/// so `ethrex_simulateFrameTransaction` tells which opcode/param halts or which check fails on this build.
contract VerifyBisect is HegotaSupport(Devnet.ERC8421_WORKSHOP) {
    address public immutable owner;
    constructor(address owner_) payable { owner = owner_; }

    fallback() external payable {
        uint8 raw = msg.data.length == 0 ? 0 : uint8(msg.data[0]);
        uint8 which = raw & 0x7f;   // bit 7 set = called in a SENDER frame: do the read, skip APPROVE
        if (which == 1) txparam(TxParam.CURRENT_FRAME_INDEX);
        else if (which == 2) require(frameparam(0, FrameParam.MODE) == uint256(FrameMode.VERIFY), "mode!=VERIFY");
        else if (which == 3) require(address(uint160(sigparam(0, SigParam.RESOLVED_SIGNER))) == owner, "signer!=owner");
        else if (which == 4) require(sigparam(0, SigParam.SCHEME) == 1, "scheme!=1");
        else if (which == 5) require(sigparam(0, SigParam.MSG) == 0, "msg!=0");
        else if (which == 6) require(txparam(TxParam.SENDER) == uint256(uint160(address(this))), "sender!=this");
        else if (which == 7) txparam(TxParam.SIG_HASH);
        else if (which == 8) require(txparam(TxParam.FRAME_COUNT) == 2, "frames!=2");
        else if (which == 9) require(txparam(TxParam.SIGNATURE_COUNT) == 1, "sigs!=1");
        else if (which == 10) txparam(TxParam.MAX_FEE);
        else if (which == 11) txparam(TxParam.NONCE);
        else if (which == 12) framedataload(0, 1);
        else if (which == 13) framedatacopy(0, 4, 1);
        else if (which == 14) sigdatacopy(0, 65, 0);
        else if (which == 15) txparam(TxParam.UNASSIGNED_05);
        else if (which == 16) txparam(TxParam.MAX_COST);
        else if (which == 17) txparam(TxParam.TYPE);
        else if (which == 18) txparam(TxParam.STATE_GAS_LEFT);
        else if (which == 19) txparam(TxParam.LEGACY_NONCE);
        else if (which == 20) txparam(TxParam.NONCE_KEY_COUNT);
        else if (which == 21) txparam(TxParam.NONCE_KEYS_HASH);
        else if (which == 22) txparam(TxParam.NONCE_KEY_0);
        else if (which == 23) frameparam(0, FrameParam.STATE_GAS_USED);
        else if (which == 24) require(sigparam(0, SigParam.SIGNATURE_LENGTH) == 65, "siglen!=65");
        else if (which == 25) require(frameparam(1, FrameParam.MODE) == uint256(FrameMode.SENDER), "f1 mode!=SENDER");
        else if (which == 26) require(frameparam(0, FrameParam.ALLOWED_SCOPE) == 3, "scope!=3");
        else if (which == 27) require(frameparam(txparam(TxParam.CURRENT_FRAME_INDEX), FrameParam.MODE) == uint256(FrameMode.VERIFY), "cur mode!=VERIFY");
        else if (which == 28) sigdatacopy(0, 8, 0);
        else if (which == 29) sigdatacopy(0, 0, 0);
        else if (which == 30) sigdatacopy(0, 8, 1);
        else if (which == 31) sigdatacopy(0, 16, 1);
        else if (which == 32) frameparam(0, FrameParam.EXECUTION_GAS_USED);
        else if (which == 33) frameparam(0, FrameParam.ATOMIC_BATCH);
        else if (which == 34) frameparam(0, FrameParam.VALUE);
        else if (which == 35) frameparam(0, FrameParam.STATE_GAS_LIMIT);
        else if (which == 36) frameparam(0, FrameParam.STATUS);
        else if (which == 37) frameparam(0, FrameParam.DATA_LENGTH);
        else if (which == 38) frameparam(0, FrameParam.EXECUTION_GAS_LIMIT);
        else if (which == 39) frameparam(0, FrameParam.FLAGS);
        else if (which == 40) frameparam(0, FrameParam.RESOLVED_TARGET);
        else if (which == 41) sigdatacopy(1, 32, 0);
        else if (which == 42) sigdatacopy(0, 32, 0);
        else if (which == 43) require(sigparam(1, SigParam.SIGNATURE_LENGTH) == 16, "sig1 len!=16");
        if (raw & 0x80 == 0) approve(Scope.EXECUTION_AND_PAYMENT);
    }
}
