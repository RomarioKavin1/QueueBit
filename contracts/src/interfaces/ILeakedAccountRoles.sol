// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ILeakedAccountRoles
/// @notice The role entry points of the LEAKED account (`src/account/LeakedAccountRoles.sol`, DELEGATECALLed from
///         `LeakedAccountImpl`'s fallback) that the role signers call, plus the permissionless executors of queued
///         operations and the role views (plan `10-contracts.md` §10.3.2, "Role entry points", as amended by
///         `ILeakedAccount`'s header: no `vaultSetDomain`; `vaultSetFeePolicy`, `vaultSetValueVerifier`,
///         `vaultSetTrustedVerifier` and `recoveryFinalizeVaultRotation` added). The account authorises the caller
///         by `msg.sender` (vault / recovery signer, guardian). This file exists so that the role signers (an
///         unbound `PQRoleSigner` reads `getRoles`), their tests and scripts can encode calldata without depending
///         on the account implementation; `test/roles` asserts selector parity with `LeakedAccountRoles`.
interface ILeakedAccountRoles {
    /// Same layout as `ILeakedAccount.Call`.
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    // ---- vault (msg.sender == vaultSigner) ----
    function vaultExecute(Call[] calldata calls, uint256 usdValue) external;
    function vaultQueue(Call[] calldata calls, uint8 kind) external returns (bytes32 opId);
    function vaultCancel(bytes32 opId) external;
    function vaultSetHotKey(address newHotKey) external;
    function vaultSetCap(uint256 capUsdPerDay, uint256 perTxMaxUsd, uint256 maxFeeWeiPerTx, uint8 maxHotFrames)
        external;
    function vaultSetFeePolicy(uint256 maxPriorityFeePerGas, bool selfPay, address tank) external;
    function vaultSetToken(address token, bool allowed, uint8 decimals, uint256 usdPerToken) external;
    function vaultSetTarget(address target, bool allowed) external;
    function vaultSetSession(address target, bytes4 selector, uint256 allowanceUsd, uint48 expiry) external;
    function vaultSetValueVerifier(address verifier, bool denied) external;
    function vaultSetTrustedVerifier(address verifier, bool trusted) external;
    function vaultSetTimelock(uint48 delay, uint256 thresholdUsd) external;
    function vaultSetRecoverySigner(address newRecoverySigner) external;
    function vaultSetGuardian(address guardian, bool enabled) external;
    function vaultFreeze() external;
    function vaultUnfreeze() external;
    function vaultExtendFreeze(uint48 until) external;
    function vaultEnableBunker() external;
    function vaultQueueUpgrade(address newImpl) external returns (bytes32 opId);
    function vaultQueueMigrate(address newAccount, address[] calldata tokens) external returns (bytes32 opId);

    // ---- recovery (msg.sender == recoverySigner) ----
    function recoveryCancel(bytes32 opId) external;
    function recoveryStartVaultRotation(address newVaultSigner) external;
    function recoveryFinalizeVaultRotation() external;
    function recoveryCancelVaultRotation() external;

    // ---- guardian (msg.sender is an enabled guardian: EOA or GuardianSigner) ----
    function guardianFreeze() external;

    // ---- anyone, after the timelock (vault authority for queued ops) ----
    function executeQueued(bytes32 opId, Call[] calldata calls) external;
    function executeUpgrade(address newImpl) external;
    function executeMigrate(address newAccount, address[] calldata tokens) external;

    // ---- views ----
    function getRoles()
        external
        view
        returns (
            address vaultSigner,
            address recoverySigner,
            address pendingVaultSigner,
            uint48 pendingVaultEta,
            uint32 vaultEpoch
        );
    function getVaultBucket() external view returns (uint256 available, uint256 cap, uint48 delay);
    function isQueued(bytes32 opId) external view returns (bool);
    function isValueVerifier(address verifier) external view returns (bool);
    function isTrustedVerifier(address verifier) external view returns (bool);
}
