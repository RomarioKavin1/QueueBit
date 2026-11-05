// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Host account kinds the policy hook recognises at install (`HotView.host`). The validator adapts two things to
// them: how it checks that the hook is still bound to the account, and whether hot-key ERC-1271 is on at all.
uint8 constant HOST_GENERIC = 0; // any ERC-7579 account with a global hook (reference MSA, Nexus-like)
uint8 constant HOST_KERNEL = 1; // Kernel v3: hook bound per validator; 1271 hashes rewrapped (hot 1271 is off)
uint8 constant HOST_SAFE = 2; // Safe7579: a Safe whose owner path bypasses hooks (owners must be keyless)

/// @title ILeakedModules
/// @notice Types, events and errors of the LEAKED ERC-7579 backend (plan `10-contracts.md` §10.4): the hot-key
///         validator (type 1), the policy hook (type 4) and the role executor (type 2). Policy semantics follow the
///         frame-native account (`src/account`, §10.3.2-§10.3.5); the type layouts are duplicated here on purpose so
///         that the module audit scope does not move when the account's interface changes (see
///         `docs/plan/IMPLEMENTATION-NOTES.md`, "Contracts M7").
interface ILeakedModules {
    // ------------------------------------------------------------------------------------------------ types ------

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    struct TokenCfg {
        bool allowed;
        uint8 decimals;
        /// USD (6 decimals) per one whole token (10**decimals base units). Vault-set, static.
        uint256 usdPerToken;
    }

    struct Session {
        uint256 allowanceUsd;
        uint48 expiry;
    }

    struct TokenInit {
        address token;
        uint8 decimals;
        uint256 usdPerToken;
    }

    /// `LeakedPolicyHook.onInstall` data (abi-encoded). The hot key and the initial allowlist are set by the account
    /// creator; afterwards only the role executor writes policy.
    struct HookInit {
        address hotKey;
        uint256 capUsdPerDay;
        uint256 perTxMaxUsd;
        /// Bound on the account-paid prefund of one hot userOp: sum of gas limits x maxFeePerGas (wei).
        uint256 maxFeeWei;
        uint256 maxPriorityFeePerGas;
        /// USD (6 decimals) per 1 ETH; 0 = ETH is not hot-spendable.
        uint256 ethUsdPrice;
        TokenInit[] tokens;
        address[] targets;
    }

    /// The validation-time view of an account's hot policy (one STATICCALL from the validator).
    struct HotView {
        address hotKey;
        bool initialized;
        bool frozen;
        bool bunker;
        uint256 perTxMaxUsd;
        uint256 maxFeeWei;
        uint256 maxPriorityFeePerGas;
        uint256 capUsdPerDay;
        /// `HOST_*`, fixed at install.
        uint8 host;
    }

    /// `LeakedRoleExecutor.onInstall` data (abi-encoded).
    struct ExecutorInit {
        address hook;
        address verifier;
        bytes32 vaultPk;
        /// bytes32(0) = no recovery key yet (bunker cannot be enabled until one is installed).
        bytes32 recoveryPk;
        /// 0 = default (48 h).
        uint48 timelockDelay;
        /// Daily allowance for instant vault spends (a rolling bucket); anything larger is queued.
        uint256 timelockThresholdUsd;
        address[] guardians;
    }

    enum OpState {
        NONE,
        PENDING,
        EXECUTED,
        CANCELLED
    }

    struct QueuedOp {
        uint48 eta;
        uint8 kind;
        OpState state;
        uint32 vaultEpoch;
        bytes32 callsHash;
    }

    struct GuardianCfg {
        bool enabled;
        uint48 lastFreezeAt;
    }

    // ----------------------------------------------------------------------------------------------- events ------

    event HotExecuted(address indexed account, uint256 usdDebited, uint256 available, uint256 callCount);
    event SessionUsed(address indexed account, bytes32 indexed sessionId, uint256 usdDebited, uint256 allowanceLeft);
    event HashRegistered(
        address indexed account, bytes32 indexed hash, address indexed token, uint256 amount, uint48 expiry
    );
    event HotKeyRotated(address indexed account, address indexed oldKey, address indexed newKey);
    event CapUpdated(
        address indexed account, uint256 capUsdPerDay, uint256 perTxMaxUsd, uint256 maxFeeWei, uint256 maxPrioFee
    );
    event TokenConfigured(address indexed account, address indexed token, bool allowed, uint8 decimals, uint256 usd);
    event TargetConfigured(address indexed account, address indexed target, bool allowed);
    event SessionConfigured(
        address indexed account, address indexed target, bytes4 indexed selector, uint256 allowanceUsd, uint48 expiry
    );
    event ValueVerifierSet(address indexed account, address indexed verifier, bool denied);
    event TrustedVerifierSet(address indexed account, address indexed verifier, bool trusted);
    event Frozen(address indexed account, address indexed by, uint48 until);
    event Unfrozen(address indexed account, address indexed by);
    event BunkerEnabled(address indexed account);
    event BunkerDisabled(address indexed account);

    event VaultExecuted(address indexed account, uint256 usdDebited, uint256 vaultAvailable, uint256 callCount);
    event Queued(address indexed account, bytes32 indexed opId, uint8 kind, uint48 eta);
    event QueueExecuted(address indexed account, bytes32 indexed opId);
    event QueueCancelled(address indexed account, bytes32 indexed opId, bool byRecovery);
    event TimelockUpdated(address indexed account, uint48 delay, uint256 thresholdUsd);
    event RecoveryKeySet(address indexed account, bytes32 pk);
    event GuardianSet(address indexed account, address indexed guardian, bool enabled);
    event VaultRotationStarted(address indexed account, bytes32 newVaultPk, uint48 eta);
    event VaultRotationFinalized(address indexed account, bytes32 newVaultPk);
    event VaultRotationCancelled(address indexed account, bytes32 newVaultPk);

    // ----------------------------------------------------------------------------------------------- errors ------

    error NotInitialized(address account);
    error AlreadyInitialized(address account);
    error Unauthorized();
    error Reentrancy();
    error BadConfig();
    error BadAddress(address a);
    error BadExpiry();

    // execution calldata (validator and hook)
    error BadCallData();
    error UnsupportedMode(bytes32 mode);
    error BadCallCount(uint256 count);

    // hot policy
    error HotDisabled();
    error HotFrozen();
    error BunkerActive();
    error FrozenOnlyClear();
    error NotAllowed(address target, bytes4 selector);
    error TokenNotAllowed(address token);
    error PerTxMaxExceeded(uint256 usd, uint256 max);
    error OverDailyCap(uint256 usd, uint256 cap);
    error SessionAllowanceExceeded(bytes32 sessionId, uint256 used, uint256 allowance);
    error StandingApproval(address token, address spender);
    error FeeTooHigh();
    error NotInHotBatch();
    error FreezeNotExpired(uint48 until);
    error NotFrozen();
    error TooManyTokens();
    error HookNotInstalled();
    error HostOwnerNotKeyless(address owner);

    // roles and timelock
    error MustQueue();
    error BadSignature();
    error BadNonce(uint256 expected, uint256 got);
    error VaultOverDailyThreshold(uint256 usd, uint256 available);
    error RotationPending();
    error NoRotationPending();
    error RotationNotReady(uint48 eta);
    error BunkerNeedsRecovery();
    error BadOp(bytes32 opId);
    error OpNotReady(bytes32 opId, uint48 eta);
    error PayloadMismatch();
    error BadKind(uint8 kind);
    error GuardianCooldown(uint48 nextAt);
    error CallFailed(uint256 index, bytes reason);
}
