// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "../../../src/modules/interfaces/IERC7579Modules.sol";

/// Minimal interfaces of the EntryPoint v0.8.0 and the host accounts, written from their pinned sources
/// (lib/account-abstraction @ v0.8.0, lib/erc7579-implementation @ 99cbd34, lib/safe7579 @ 9f507f3,
/// lib/safe-smart-account @ v1.4.1, lib/kernel @ v3.3), so that tests need not import the hosts.

interface IEntryPointV08 {
    event UserOperationEvent(
        bytes32 indexed userOpHash,
        address indexed sender,
        address indexed paymaster,
        uint256 nonce,
        bool success,
        uint256 actualGasCost,
        uint256 actualGasUsed
    );
    event UserOperationRevertReason(
        bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason
    );

    error FailedOp(uint256 opIndex, string reason);
    error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner);

    function handleOps(PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function depositTo(address account) external payable;
    function balanceOf(address account) external view returns (uint256);
    function senderCreator() external view returns (address);
    function getDomainSeparatorV4() external view returns (bytes32);
}

interface IAccount4337 {
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        returns (uint256);
}

interface IERC7579AccountView {
    function installModule(uint256 moduleTypeId, address module, bytes calldata initData) external payable;
    function uninstallModule(uint256 moduleTypeId, address module, bytes calldata deInitData) external payable;
    function isModuleInstalled(uint256 moduleTypeId, address module, bytes calldata additionalContext)
        external
        view
        returns (bool);
    function accountId() external view returns (string memory);
    function isValidSignature(bytes32 hash, bytes calldata data) external view returns (bytes4);
}

// ---- reference MSA (erc7579-implementation) ----

struct MSABootstrapConfig {
    address module;
    bytes data;
}

interface IMSABootstrap {
    function initMSA(
        MSABootstrapConfig[] calldata validators,
        MSABootstrapConfig[] calldata executors,
        MSABootstrapConfig calldata hook,
        MSABootstrapConfig[] calldata fallbacks
    ) external;
}

interface IMSAFactory {
    function createAccount(bytes32 salt, bytes calldata initCode) external payable returns (address);
    function getAddress(bytes32 salt, bytes calldata initcode) external view returns (address);
}

// ---- Safe + Safe7579 ----

struct Safe7579ModuleInit {
    address module;
    bytes initData;
    uint256 moduleType;
}

interface ISafeSetup {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function getOwners() external view returns (address[] memory);
    function isModuleEnabled(address module) external view returns (bool);
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafe7579Launchpad {
    function addSafe7579(
        address safe7579,
        Safe7579ModuleInit[] calldata modules,
        address[] calldata attesters,
        uint8 threshold
    ) external;
}

// ---- Kernel v3.3 ----

interface IKernelFactory {
    function createAccount(bytes calldata data, bytes32 salt) external payable returns (address);
}

interface IKernelInit {
    function initialize(
        bytes21 rootValidator,
        address hook,
        bytes calldata validatorData,
        bytes calldata hookData,
        bytes[] calldata initConfig
    ) external;
    function installModule(uint256 moduleType, address module, bytes calldata initData) external payable;
}

// ---- SimpleAccount v0.8 (the relayer account in the gas measurements) ----

interface ISimpleAccount {
    function initialize(address owner) external;
    function execute(address target, uint256 value, bytes calldata data) external;
}
