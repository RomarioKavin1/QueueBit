// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ERC-7579 (modular smart accounts) and ERC-8286 (Draft: modular accounts for EIP-8141 frame transactions).

/// ERC-7579 module type ids, plus ERC-8286's frame validator (11, "TBD" in the draft).
library ModuleType {
    uint256 internal constant VALIDATOR = 1;
    uint256 internal constant EXECUTOR = 2;
    uint256 internal constant FALLBACK = 3;
    uint256 internal constant HOOK = 4;
    uint256 internal constant FRAME_VALIDATOR = 11;
}

/// ERC-8286 approval modes: the EIP-8141 APPROVE scope bits.
library ApprovalMode {
    uint8 internal constant NONE = 0x0;
    uint8 internal constant PAYMENT = 0x1;
    uint8 internal constant EXECUTION = 0x2;
    uint8 internal constant EXECUTION_AND_PAYMENT = 0x3;
    uint8 internal constant SCOPE_MASK = 0x3;
}

/// ERC-7579 execution mode layout: callType (byte 0), execType (byte 1), unused (4), modeSelector (4), payload (22).
library ExecMode {
    bytes1 internal constant CALLTYPE_SINGLE = 0x00;
    bytes1 internal constant CALLTYPE_BATCH = 0x01;
    // ERC-8286 frame call types (declarations for supportsExecutionMode only).
    bytes1 internal constant CALLTYPE_FRAME_SINGLE = 0x02;
    bytes1 internal constant CALLTYPE_FRAME_BATCH = 0x03;
    bytes1 internal constant EXECTYPE_DEFAULT = 0x00;
    bytes1 internal constant EXECTYPE_TRY = 0x01;

    function encode(bytes1 callType, bytes1 execType) internal pure returns (bytes32) {
        return bytes32(abi.encodePacked(callType, execType, bytes30(0)));
    }

    function callType(bytes32 mode) internal pure returns (bytes1) {
        return bytes1(mode);
    }

    function execType(bytes32 mode) internal pure returns (bytes1) {
        return bytes1(mode << 8);
    }
}

/// ERC-7579 batch item.
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
}

interface IERC7579Hook is IERC7579Module {
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        returns (bytes memory hookData);
    function postCheck(bytes calldata hookData) external;
}

interface IERC7579AccountConfig {
    function accountId() external view returns (string memory);
    function supportsExecutionMode(bytes32 encodedMode) external view returns (bool);
    function supportsModule(uint256 moduleTypeId) external view returns (bool);
}

interface IERC7579ModuleConfig {
    event ModuleInstalled(uint256 moduleTypeId, address module);
    event ModuleUninstalled(uint256 moduleTypeId, address module);

    function installModule(uint256 moduleTypeId, address module, bytes calldata initData) external payable;
    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData) external payable;
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool);
}

interface IERC7579Execution {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);
}

/// ERC-8286 frame validator (module type 11).
interface IFrameValidator is IERC7579Module {
    /// Reads the tx through EIP-8141 introspection; returns the approval mode it authorizes (0 = none). View only.
    function validateFrame(bytes calldata data) external view returns (uint8 approvalMode);
}

/// ERC-8286 account.
interface IERC8286FrameAccount is IERC7579AccountConfig, IERC7579ModuleConfig {
    function verify(bytes calldata data) external returns (uint8 approvalMode);
    function supportsApprovalMode(uint8 approvalMode) external view returns (bool);
    function executionRoute() external view returns (uint8);
}
