// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IQueueBitAccount} from "./IQueueBitAccount.sol";
import {RollingCap} from "../lib/RollingCap.sol";

/// @title QueueBitAccountStorage
/// @notice The account's ERC-7201 namespaced storage (`@custom:storage-location erc7201:queuebit.account.v1`).
/// @dev Slot = keccak256(abi.encode(uint256(keccak256("queuebit.account.v1")) - 1)) & ~bytes32(uint256(0xff)).
///      The first three slots are everything the VERIFY walker reads (§10.5.1); they are written only by role paths
///      (vault, recovery, guardian, `clearExpiredFreeze`, `initialize`), never by `hotExecute` (I-2, C4).
///      Append-only: an upgrade may add fields at the end of `Layout`, never reorder or retype.
library QueueBitAccountStorage {
    /// @custom:storage-location erc7201:queuebit.account.v1
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
        mapping(address token => IQueueBitAccount.TokenCfg) tokens;
        /// Allowlisted ERC-20s (not ETH), the assets the balance-delta accounting monitors. Bounded by MAX_TOKENS.
        address[] tokenList;
        mapping(address target => bool) targets;
        mapping(bytes32 sessionId => IQueueBitAccount.Session) sessions;
        mapping(bytes32 hash => uint48 expiry) registeredHashes;
        /// Contracts that may never get a hot-key 7739 signature accepted (token permits, Permit2).
        mapping(address verifier => bool) valueVerifiers;
        // ---- roles ----
        address vaultSigner;
        uint32 vaultEpoch;
        address recoverySigner;
        mapping(address guardian => IQueueBitAccount.GuardianCfg) guardians;
        // ---- timelock ----
        uint48 timelockDelay;
        /// Instant vault spends: a rolling daily bucket whose cap is the timelock threshold.
        RollingCap.Bucket vaultBucket;
        mapping(bytes32 opId => IQueueBitAccount.QueuedOp) queue;
        uint256 opNonce;
        // ---- recovery ----
        address pendingVaultSigner;
        uint48 pendingVaultEta;
        // ---- upgrade / migrate ----
        bytes32 pendingUpgradeOp;
        address pendingImpl;
        bytes32 pendingMigrateOp;
        // ---- appended (audit 2026-11-06) ----
        /// On-chain verifiers the vault vouches for as unable to move the account's assets on a signature alone:
        /// the only contracts that may consume a hot-key ERC-7739 signature or an opaque registered hash.
        mapping(address verifier => bool) trustedVerifiers;
        /// A registered hash bound to one consumer (`registerPermit`: the token); address(0) = the verifier rule.
        mapping(bytes32 hash => address consumer) registeredFor;
        // ---- appended (recipient policy, 2026-11-06) ----
        /// `RecipientMode.Open` when true. Stored inverted (false = Strict) so that the zero value of this appended
        /// slot fails closed: an account upgraded from an implementation without the field keeps the recipient
        /// allowlist. Execution-only (VERIFY never reads it; I-2): written by `initialize` and the vault only.
        bool recipientsOpen;
        // ---- appended (LeanPool PQ everyday key, 2026-11-06) ----
        /// The Vault-installed `LeanPoolHotSigner` that may call `hotExecuteFrom`; address(0) = none. Execution-only
        /// (VERIFY never reads it; I-2): written by the vault only.
        address pqHotSigner;
    }

    bytes32 internal constant SLOT = 0xaaa3a40665f3919275337b30482a6844d30bf6a88669b7017e78138704481500;

    function layout() internal pure returns (Layout storage $) {
        assembly ("memory-safe") {
            $.slot := SLOT
        }
    }
}
