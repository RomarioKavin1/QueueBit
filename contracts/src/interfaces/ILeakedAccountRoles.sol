// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ILeakedAccountRoles
/// @notice The role entry points of `LeakedAccountImpl` that the role signers call (plan `10-contracts.md` §10.3.2,
///         "Role entry points"). Names and argument lists are copied from the plan; the account authorises the
///         caller by `msg.sender` (vault / recovery signer, guardian). This file exists so that the role signers'
///         tests and scripts can encode calldata without depending on the account implementation.
interface ILeakedAccountRoles {
    /// `struct Call { address target; uint256 value; bytes data; }` (§10.3 conventions).
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
    function vaultSetToken(address token, bool allowed, uint8 decimals, uint256 usdPer1e18) external;
    function vaultSetTarget(address target, bool allowed) external;
    function vaultSetSession(address target, bytes4 selector, uint256 allowanceUsd, uint48 expiry) external;
    function vaultSetDomain(bytes32 domainSeparator, bool allowed) external;
    function vaultFreeze() external;
    function vaultUnfreeze() external;
    function vaultExtendFreeze(uint48 until) external;
    function vaultSetGuardian(address guardian, bool enabled) external;
    function vaultSetRecoverySigner(address recoverySigner) external;
    function vaultEnableBunker() external;
    function vaultSetTimelock(uint48 delay, uint256 thresholdUsd) external;
    function vaultQueueUpgrade(address newImpl) external;
    function vaultQueueMigrate(address newAccount, address[] calldata tokens) external;

    // ---- recovery (msg.sender == recoverySigner) ----
    function recoveryCancel(bytes32 opId) external;
    function recoveryStartVaultRotation(address newVaultSigner) external;
    function recoveryCancelVaultRotation() external;

    // ---- guardian (msg.sender is an enabled guardian: EOA or GuardianSigner) ----
    function guardianFreeze() external;
}
