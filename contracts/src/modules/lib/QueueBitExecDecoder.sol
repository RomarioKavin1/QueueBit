// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Execution} from "../interfaces/IERC7579Modules.sol";
import {IQueueBitModules} from "../interfaces/IQueueBitModules.sol";

/// @title QueueBitExecDecoder
/// @notice Decodes the only call shape the hot tier may use, ERC-7579 `execute(bytes32 mode, bytes executionCalldata)`
///         with `mode` = single/default (`0x00..00`) or batch/default (`0x01 00..00`) [ERC-7579 §"Execution Behavior",
///         mode layout callType(1) | execType(1) | unused(4) | modeSelector(4) | modePayload(22)].
/// @dev    The validator decides on bytes it parsed itself while the host account parses the same bytes again, so
///         any encoding the two could read differently is refused: the ABI head must be canonical (offset 0x40, no
///         gap), the batch must re-encode to exactly the bytes given, and nothing may follow the encoding except the
///         20-byte ERC-2771 sender that Safe7579's fallback appends to `msg.data` (only where `allowSenderSuffix`).
///         TRY (`execType 0x01`), DELEGATECALL (`0xff`), STATIC (`0xfe`), mode selectors and payloads are rejected.
library QueueBitExecDecoder {
    /// `execute(bytes32,bytes)` [ERC-7579].
    bytes4 internal constant EXECUTE = 0xe9ae5c53;
    /// `executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)` [ERC-4337
    /// `IAccountExecute`]: EntryPoint v0.7+/v0.8 calls it instead of the raw callData when callData starts with it;
    /// Kernel v3.3 requires it for userOps whose validator has a hook (`Kernel.sol:269`).
    bytes4 internal constant EXECUTE_USER_OP = 0x8dd7712f;

    bytes32 internal constant MODE_SINGLE = bytes32(0);
    bytes32 internal constant MODE_BATCH = bytes32(bytes1(0x01));

    /// Decodes a userOp's `callData`: `execute(...)`, optionally wrapped as `executeUserOp.selector ‖ execute(...)`.
    function decodeUserOpCallData(bytes calldata callData) internal pure returns (Execution[] memory) {
        if (callData.length >= 4 && bytes4(callData[0:4]) == EXECUTE_USER_OP) callData = callData[4:];
        return decodeExecute(callData, false);
    }

    /// Decodes `execute(mode, executionCalldata)` (selector included) under the canonical-encoding rules above.
    function decodeExecute(bytes calldata data, bool allowSenderSuffix)
        internal
        pure
        returns (Execution[] memory execs)
    {
        if (data.length < 100 || bytes4(data[0:4]) != EXECUTE) revert IQueueBitModules.BadCallData();
        bytes32 mode = bytes32(data[4:36]);
        if (uint256(bytes32(data[36:68])) != 0x40) revert IQueueBitModules.BadCallData();
        uint256 len = uint256(bytes32(data[68:100]));
        if (len > data.length - 100) revert IQueueBitModules.BadCallData();
        uint256 end = 100 + ((len + 31) & ~uint256(31));
        if (data.length != end && !(allowSenderSuffix && data.length == end + 20)) {
            revert IQueueBitModules.BadCallData();
        }
        bytes calldata ec = data[100:100 + len];
        // Zero padding after the bytes value (canonical ABI).
        for (uint256 i = 100 + len; i < end; ++i) {
            if (data[i] != 0) revert IQueueBitModules.BadCallData();
        }

        if (mode == MODE_SINGLE) {
            if (ec.length < 52) revert IQueueBitModules.BadCallData();
            execs = new Execution[](1);
            execs[0] = Execution(address(bytes20(ec[0:20])), uint256(bytes32(ec[20:52])), ec[52:]);
        } else if (mode == MODE_BATCH) {
            execs = abi.decode(ec, (Execution[]));
            if (keccak256(abi.encode(execs)) != keccak256(ec)) revert IQueueBitModules.BadCallData();
        } else {
            revert IQueueBitModules.UnsupportedMode(mode);
        }
    }

    function selectorOf(bytes memory data) internal pure returns (bytes4 sel) {
        if (data.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            sel := mload(add(data, 0x20))
        }
    }

    /// The `i`-th 32-byte ABI word after the selector (0-based); the caller checks the length.
    function argWord(bytes memory data, uint256 i) internal pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 0x24), mul(i, 0x20)))
        }
    }
}
