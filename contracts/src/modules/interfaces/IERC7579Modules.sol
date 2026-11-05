// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Minimal ERC-4337 / ERC-7579 interfaces used by the LEAKED modules
/// @notice Written from the standards' text so that `src/modules` imports nothing from the (partly GPL) host and
///         EntryPoint repositories. Each item names its source:
///         - `PackedUserOperation`: ERC-4337 (EntryPoint v0.7/v0.8 struct), field order as in
///           `eth-infinitism/account-abstraction` v0.8.0 `contracts/interfaces/PackedUserOperation.sol`;
///         - module type ids 1/2/3/4 and the module interfaces: ERC-7579 §"Modules"
///           (`erc7579/erc7579-implementation` @ 99cbd34 `src/interfaces/IERC7579Module.sol:9-12`);
///         - `isInitialized(address)` is not in the ERC text; it is the reference implementation's (and Kernel
///           v3.3 calls it before `onInstall` of a hook, `kernel/src/core/HookManager.sol:34`);
///         - `executeFromExecutor(bytes32,bytes)`: ERC-7579 §"Execution" (`ModeCode` is a `bytes32`).

struct PackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

/// ERC-7579 `Execution` (the element of a batch `executionCalldata = abi.encode(Execution[])`).
struct Execution {
    address target;
    uint256 value;
    bytes callData;
}

uint256 constant MODULE_TYPE_VALIDATOR = 1;
uint256 constant MODULE_TYPE_EXECUTOR = 2;
uint256 constant MODULE_TYPE_FALLBACK = 3;
uint256 constant MODULE_TYPE_HOOK = 4;

uint256 constant VALIDATION_SUCCESS = 0;
uint256 constant VALIDATION_FAILED = 1;

bytes4 constant ERC1271_MAGIC = 0x1626ba7e;
bytes4 constant ERC1271_INVALID = 0xffffffff;

interface IERC7579Module {
    function onInstall(bytes calldata data) external;
    function onUninstall(bytes calldata data) external;
    function isModuleType(uint256 moduleTypeId) external view returns (bool);
    function isInitialized(address smartAccount) external view returns (bool);
}

interface IERC7579Validator is IERC7579Module {
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external returns (uint256);
    function isValidSignatureWithSender(address sender, bytes32 hash, bytes calldata data)
        external
        view
        returns (bytes4);
}

interface IERC7579Hook is IERC7579Module {
    function preCheck(address msgSender, uint256 msgValue, bytes calldata msgData)
        external
        returns (bytes memory hookData);
    function postCheck(bytes calldata hookData) external;
}

interface IERC7579Execution {
    function execute(bytes32 mode, bytes calldata executionCalldata) external payable;
    function executeFromExecutor(bytes32 mode, bytes calldata executionCalldata)
        external
        payable
        returns (bytes[] memory returnData);
}
