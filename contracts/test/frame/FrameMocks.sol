// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FrameTxModel} from "./FrameTxModel.sol";

// Stand-ins for HegotaSupport's Yul helpers, etched (`vm.etch`) at the helpers' addresses by `FrameSim`. They keep the
// helpers' calling convention (`contracts/internal/HelperCalls.sol` in @forshtat/hegota-support): operands arrive as
// consecutive 32-byte words with no selector, read helpers answer with raw bytes (one word, or the copied bytes), and
// failures revert with the model's revert data, which HelperCalls bubbles up. The model address is an immutable, so
// it survives `vm.etch` (it is part of the runtime code).

/// Base: forwards a revert from the model unchanged.
abstract contract FrameMock {
    FrameTxModel internal immutable MODEL;

    constructor(FrameTxModel model) {
        MODEL = model;
    }

    function _returnWord(uint256 word) internal pure {
        assembly ("memory-safe") {
            mstore(0, word)
            return(0, 32)
        }
    }

    function _returnBytes(bytes memory b) internal pure {
        assembly ("memory-safe") {
            return(add(b, 32), mload(b))
        }
    }

    function _word(uint256 i) internal pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := calldataload(mul(i, 32))
        }
    }
}

/// APPROVE (0xaa). Delegatecalled by the account, so the call to the model comes from the account (ADDRESS).
contract MockApprove is FrameMock {
    constructor(FrameTxModel model) FrameMock(model) {}

    fallback() external payable {
        MODEL.approve(_word(0));
    }
}

contract MockTxParam is FrameMock {
    constructor(FrameTxModel model) FrameMock(model) {}

    fallback() external payable {
        _returnWord(MODEL.txParam(_word(0)));
    }
}

contract MockFrameDataLoad is FrameMock {
    constructor(FrameTxModel model) FrameMock(model) {}

    fallback() external payable {
        _returnWord(uint256(MODEL.frameDataLoad(_word(0), _word(1))));
    }
}

contract MockFrameDataCopy is FrameMock {
    constructor(FrameTxModel model) FrameMock(model) {}

    fallback() external payable {
        _returnBytes(MODEL.frameDataCopy(_word(0), _word(1), _word(2)));
    }
}

contract MockFrameParam is FrameMock {
    constructor(FrameTxModel model) FrameMock(model) {}

    fallback() external payable {
        _returnWord(MODEL.frameParam(_word(0), _word(1)));
    }
}

contract MockSigParam is FrameMock {
    constructor(FrameTxModel model) FrameMock(model) {}

    fallback() external payable {
        _returnWord(MODEL.sigParam(_word(0), _word(1)));
    }
}

contract MockSigDataCopy is FrameMock {
    constructor(FrameTxModel model) FrameMock(model) {}

    fallback() external payable {
        _returnBytes(MODEL.sigDataCopy(_word(0), _word(1), _word(2)));
    }
}

/// For opcodes the simulator does not model (the EIP-7906 TXTRACE / EVENTDATACOPY helpers).
contract MockUnmodelled {
    error FrameSimUnsupported(string what, uint256 id);

    fallback() external payable {
        revert FrameSimUnsupported("opcode not modelled by FrameSim", 0);
    }
}
