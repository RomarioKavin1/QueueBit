// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILeakedAccount} from "./ILeakedAccount.sol";
import {RollingCap} from "../lib/RollingCap.sol";

/// @title LeakedAccountStorage
/// @notice The account's ERC-7201 namespaced storage (`@custom:storage-location erc7201:leaked.account.v1`).
/// @dev Slot = keccak256(abi.encode(uint256(keccak256("leaked.account.v1")) - 1)) & ~bytes32(uint256(0xff)).
///      The first three slots are everything the VERIFY walker reads (§10.5.1); they are written only by role paths
///      (vault, recovery, guardian, `clearExpiredFreeze`, `initialize`), never by `hotExecute` (I-2, C4).
///      Append-only: an upgrade may add fields at the end of `Layout`, never reorder or retype.
library LeakedAccountStorage {
    /// @custom:storage-location erc7201:leaked.account.v1
    struct Layout {
        // ---- slot 0: read in VERIFY ----
        address hotKey;
        bool hotFrozen;
        bool bunker;
        bool selfPay;
        uint8 maxHotFrames;
        // ---- slot 1: read in VERIFY ----
        address tank;
        uint96 perTxMaxUsd;
        // ---- slot 2: read in VERIFY ----
        uint128 maxFeeWeiPerTx;
        uint128 maxPriorityFeePerGas;
        // ---- execution-only state ----
        uint48 frozenUntil;
        RollingCap.Bucket hotBucket;
        mapping(address token => ILeakedAccount.TokenCfg) tokens;
        /// Allowlisted ERC-20s (not ETH), the assets the balance-delta accounting monitors. Bounded by MAX_TOKENS.
        address[] tokenList;
        mapping(address target => bool) targets;
        mapping(bytes32 sessionId => ILeakedAccount.Session) sessions;
        mapping(bytes32 hash => uint48 expiry) registeredHashes;
        /// Contracts that may never get a hot-key 7739 signature accepted (token permits, Permit2).
        mapping(address verifier => bool) valueVerifiers;
        // ---- roles ----
        address vaultSigner;
        uint32 vaultEpoch;
        address recoverySigner;
        mapping(address guardian => ILeakedAccount.GuardianCfg) guardians;
        // ---- timelock ----
        uint48 timelockDelay;
        /// Instant vault spends: a rolling daily bucket whose cap is the timelock threshold.
        RollingCap.Bucket vaultBucket;
        mapping(bytes32 opId => ILeakedAccount.QueuedOp) queue;
        uint256 opNonce;
        // ---- recovery ----
        address pendingVaultSigner;
        uint48 pendingVaultEta;
        // ---- upgrade / migrate ----
        bytes32 pendingUpgradeOp;
        address pendingImpl;
        bytes32 pendingMigrateOp;
    }

    bytes32 internal constant SLOT = 0x9eadb468a7841dcf4c48ba06e49dbfab6d1eb75065d9b194aac64cacb775e800;

    function layout() internal pure returns (Layout storage $) {
        assembly ("memory-safe") {
            $.slot := SLOT
        }
    }
}
