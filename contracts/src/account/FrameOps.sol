// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/Devnet.sol";
import {HelperCode} from "@forshtat/hegota-support/contracts/generated/HelperCode.sol";

/// Deploys each EIP-8141 introspection helper once (APPROVE, TXPARAM, FRAMEDATALOAD, FRAMEDATACOPY, FRAMEPARAM,
/// SIGPARAM, SIGDATACOPY, in that nonce order), so the account and all its modules share one warm set instead of each
/// deploying its own: every distinct helper costs a cold account access in a VERIFY frame's 100k budget.
contract FrameHelperHub {
    address public immutable approveHelper;
    address public immutable txParamHelper;
    address public immutable frameDataLoadHelper;
    address public immutable frameDataCopyHelper;
    address public immutable frameParamHelper;
    address public immutable sigParamHelper;
    address public immutable sigDataCopyHelper;

    constructor() {
        Devnet d = Devnet.ERC8421_WORKSHOP;
        approveHelper = _deploy(HelperCode.approve(d));
        txParamHelper = _deploy(HelperCode.txParam(d));
        frameDataLoadHelper = _deploy(HelperCode.frameDataLoad(d));
        frameDataCopyHelper = _deploy(HelperCode.frameDataCopy(d));
        frameParamHelper = _deploy(HelperCode.frameParam(d));
        sigParamHelper = _deploy(HelperCode.sigParam(d));
        sigDataCopyHelper = _deploy(HelperCode.sigDataCopy(d));
    }

    function _deploy(bytes memory code) private returns (address h) {
        assembly ("memory-safe") {
            h := create(0, add(code, 0x20), mload(code))
        }
        require(h != address(0), "helper deployment failed");
    }
}

/// Lean access to the EIP-8141 instructions through the hub's helpers: raw staticcalls on scratch memory, no ABI
/// encoding. Parameter ids follow EIP-8141 (TXPARAM 0x02 SENDER, 0x08 SIG_HASH, 0x09 FRAME_COUNT, 0x0a
/// CURRENT_FRAME_INDEX, 0x0b SIGNATURE_COUNT; FRAMEPARAM 0x00 RESOLVED_TARGET, 0x02 MODE, 0x04 DATA_LENGTH,
/// 0x06 ALLOWED_SCOPE; SIGPARAM 0x00 RESOLVED_SIGNER, 0x01 SCHEME, 0x02 MSG, 0x03 SIGNATURE_LENGTH).
abstract contract FrameOps {
    uint256 internal constant TX_SENDER = 0x02;
    uint256 internal constant TX_SIG_HASH = 0x08;
    uint256 internal constant TX_FRAME_COUNT = 0x09;
    uint256 internal constant TX_CURRENT_FRAME = 0x0a;
    uint256 internal constant TX_SIGNATURE_COUNT = 0x0b;
    uint256 internal constant FP_TARGET = 0x00;
    uint256 internal constant FP_MODE = 0x02;
    uint256 internal constant FP_DATA_LENGTH = 0x04;
    uint256 internal constant FP_ALLOWED_SCOPE = 0x06;
    uint256 internal constant SP_SIGNER = 0x00;
    uint256 internal constant SP_SCHEME = 0x01;
    uint256 internal constant SP_MSG = 0x02;
    uint256 internal constant SP_LENGTH = 0x03;

    address internal immutable H_APPROVE;
    address internal immutable H_TX;
    address internal immutable H_FRAME_COPY;
    address internal immutable H_FRAME;
    address internal immutable H_SIG;
    address internal immutable H_SIG_COPY;

    constructor(FrameHelperHub hub) {
        H_APPROVE = hub.approveHelper();
        H_TX = hub.txParamHelper();
        H_FRAME_COPY = hub.frameDataCopyHelper();
        H_FRAME = hub.frameParamHelper();
        H_SIG = hub.sigParamHelper();
        H_SIG_COPY = hub.sigDataCopyHelper();
    }

    function _txparam(uint256 p) internal view returns (uint256 v) {
        address h = H_TX;
        assembly ("memory-safe") {
            mstore(0, p)
            if iszero(staticcall(gas(), h, 0, 0x20, 0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            v := mload(0)
        }
    }

    function _frameparam(uint256 i, uint256 p) internal view returns (uint256 v) {
        v = _two(H_FRAME, i, p);
    }

    function _sigparam(uint256 i, uint256 p) internal view returns (uint256 v) {
        v = _two(H_SIG, i, p);
    }

    function _two(address h, uint256 a, uint256 b) private view returns (uint256 v) {
        assembly ("memory-safe") {
            mstore(0, a)
            mstore(0x20, b)
            if iszero(staticcall(gas(), h, 0, 0x40, 0, 0x20)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            v := mload(0)
        }
    }

    function _framedatacopy(uint256 offset, uint256 len, uint256 i) internal view returns (bytes memory out) {
        out = _copy(H_FRAME_COPY, offset, len, i);
    }

    function _sigdatacopy(uint256 offset, uint256 len, uint256 i) internal view returns (bytes memory out) {
        out = _copy(H_SIG_COPY, offset, len, i);
    }

    /// Input (offset, length, index) at the free pointer, output lands right after the length word of `out`.
    function _copy(address h, uint256 offset, uint256 len, uint256 i) private view returns (bytes memory out) {
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, offset)
            mstore(add(p, 0x20), len)
            mstore(add(p, 0x40), i)
            out := add(p, 0x60)
            if iszero(staticcall(gas(), h, p, 0x60, add(out, 0x20), len)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
            mstore(out, len)
            mstore(0x40, add(add(out, 0x20), and(add(len, 31), not(31))))
        }
    }

    /// APPROVE(scope): ends the frame on success.
    function _approve(uint256 scope) internal {
        address h = H_APPROVE;
        assembly ("memory-safe") {
            mstore(0, scope)
            if iszero(delegatecall(gas(), h, 0, 0x20, 0, 0)) {
                returndatacopy(0, 0, returndatasize())
                revert(0, returndatasize())
            }
        }
    }

    /// `b[from:]` as a new bytes, copied with MCOPY.
    function _tailOf(bytes memory b, uint256 from) internal pure returns (bytes memory out) {
        uint256 n = b.length - from;
        assembly ("memory-safe") {
            out := mload(0x40)
            mstore(out, n)
            mcopy(add(out, 0x20), add(add(b, 0x20), from), n)
            mstore(0x40, add(add(out, 0x20), and(add(n, 31), not(31))))
        }
    }
}
