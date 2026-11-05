// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ILeakedAccount
/// @notice Types, events and errors of the LEAKED frame-native account (`LeakedAccountImpl`). Names follow
///         `docs/plan/sections/10-contracts.md` §10.3.2 / §10.11. Deviations from that text:
///         - role entry points live in `LeakedAccountRoles`, DELEGATECALLed from the implementation's fallback
///           (EIP-170: one contract was 30.6 KB); unknown selectors still revert;
///         - `initialize(InitConfig)` (adds tank, ETH price, priority-fee bound, timelock fields); the tank is
///           allowlisted as a hot recipient at initialize (UX decision);
///         - no `vaultSetDomain`/`allowedDomains`: hot-key ERC-7739 is accepted for any app domain (UX decision),
///           but the account cannot tell zero-value typed data from a permit or an order, so (audit 2026-11-06) it is
///           honoured only where it cannot move assets: for a code-less caller (eth_call verification, i.e. SIWE and
///           other off-chain checks) or a vault-trusted on-chain verifier (`vaultSetTrustedVerifier`, queued), and
///           never for an allowlisted token or a vault-denied "value verifier" (Permit2 by default);
///         - `registerHash` registers an opaque hash under the same verifier rule (its debit is self-declared, so a
///           token or Permit2 never consumes it); `registerPermit` computes an ERC-2612 permit digest on chain,
///           debits the permit's own value and binds the hash to that token;
///         - `vaultSetToken` price semantics: `usdPerToken` (USD-6 per whole token); a lower price is loosening;
///         - `vaultSetFeePolicy(maxPriorityFeePerGas, selfPay, tank)` added; `vaultExecute` draws on a rolling daily
///           allowance (cap = timelock threshold) and measures outflow instead of trusting `usdValue`;
///         - a recovery rotation also blocks vault spends/queueing/queued execution and voids older vault ops
///           (vault epoch); `HotExecuted` carries no sig hash (TXPARAM halts outside a frame tx);
///         - `getBucket()` returns `(available, lastUpdate, cap, fullAt)`: the refill is continuous, so "frees up
///           at" is when the bucket is full again.
/// @dev Paths that cannot log, by construction (the watcher must not rely on them):
///      - an over-cap hot batch reverts (`OverCap`), so its SENDER frame leaves no log; the tank's fee burn is
///        visible only in the frame receipt (`frameReceipts[i].status == 0`);
///      - `isValidSignature` is a view: accepting a registered hash or a 7739 signature emits nothing;
///      - a VERIFY frame is static: a rejected hot transaction is never included and emits nothing.
interface ILeakedAccount {
    // ------------------------------------------------------------------------------------------------ types ------

    /// One call of a hot batch, a vault batch or a queued operation.
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// Everything `initialize` sets. Zero means "default" for `maxHotFrames` (4) and `timelockDelay` (48 h).
    struct InitConfig {
        address hotKey;
        address vaultSigner;
        /// address(0) = no recovery signer yet (bunker cannot be enabled until one is installed).
        address recoverySigner;
        /// The default-code fee-tank EOA: pinned as the `pay` frame's target and allowlisted as a hot recipient
        /// (so a low tank is topped up as an everyday payment). address(0) = no pin, nothing allowlisted.
        address tank;
        uint256 capUsdPerDay;
        uint256 perTxMaxUsd;
        uint256 maxFeeWeiPerTx;
        uint256 maxPriorityFeePerGas;
        uint8 maxHotFrames;
        bool selfPay;
        uint48 timelockDelay;
        /// Daily allowance for instant vault spends (a rolling bucket); anything larger is queued.
        uint256 timelockThresholdUsd;
        /// USD (6 decimals) per 1 ETH; 0 = ETH is not a hot-spendable asset.
        uint256 ethUsdPrice;
    }

    /// The fields VERIFY reads, plus the per-tx bounds. Returned by `getHotConfig()`.
    struct HotConfig {
        address hotKey;
        bool hotFrozen;
        bool bunker;
        bool selfPay;
        uint8 maxHotFrames;
        address tank;
        uint256 perTxMaxUsd;
        uint256 maxFeeWeiPerTx;
        uint256 maxPriorityFeePerGas;
        uint48 frozenUntil;
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

    struct GuardianCfg {
        bool enabled;
        uint48 lastFreezeAt;
    }

    /// Lifecycle of a queued operation.
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
        /// The vault epoch the op was queued in; a recovery rotation bumps the epoch and orphans older ops.
        uint32 vaultEpoch;
        /// keccak256(abi.encode(calls)) for SPEND/LOOSEN, keccak256(abi.encode(impl)) for UPGRADE,
        /// keccak256(abi.encode(newAccount, tokens)) for MIGRATE.
        bytes32 payloadHash;
    }

    // ----------------------------------------------------------------------------------------------- events ------

    event HotExecuted(uint256 usdDebited, uint256 available, uint256 callCount);
    event SessionUsed(bytes32 indexed sessionId, uint256 usdDebited, uint256 allowanceLeft);
    event HashRegistered(bytes32 indexed hash, address indexed token, uint256 amount, uint48 expiry);
    event VaultExecuted(uint256 usdDebited, uint256 vaultAvailable, uint256 callCount);

    event HotKeyRotated(address indexed oldKey, address indexed newKey);
    event CapUpdated(uint256 capUsdPerDay, uint256 perTxMaxUsd, uint256 maxFeeWeiPerTx, uint8 maxHotFrames);
    event FeePolicyUpdated(uint256 maxPriorityFeePerGas, bool selfPay, address indexed tank);
    event TokenConfigured(address indexed token, bool allowed, uint8 decimals, uint256 usdPerToken);
    event TargetConfigured(address indexed target, bool allowed);
    event SessionConfigured(address indexed target, bytes4 indexed selector, uint256 allowanceUsd, uint48 expiry);
    event ValueVerifierSet(address indexed verifier, bool denied);
    event TrustedVerifierSet(address indexed verifier, bool trusted);
    event TimelockUpdated(uint48 delay, uint256 thresholdUsd);

    event Frozen(address indexed by, uint48 until);
    event Unfrozen(address indexed by);
    event BunkerEnabled();
    event BunkerDisabled();

    event Queued(bytes32 indexed opId, uint8 kind, uint48 eta);
    event QueueExecuted(bytes32 indexed opId);
    event QueueCancelled(bytes32 indexed opId, address indexed by);

    event VaultSignerSet(address indexed signer);
    event RecoverySignerSet(address indexed signer);
    event GuardianSet(address indexed guardian, bool enabled);
    event VaultRotationStarted(address indexed newVaultSigner, uint48 eta);
    event VaultRotationFinalized(address indexed newVaultSigner);
    event VaultRotationCancelled(address indexed newVaultSigner);

    event UpgradeQueued(address indexed impl, uint48 eta);
    event MigrationQueued(address indexed to, uint48 eta);
    event Migrated(address indexed to);

    // ----------------------------------------------------------------------------------------------- errors ------

    // VERIFY (the walker; §10.5.1). Each names the rule that failed.
    error NotVerifyFrame();
    error HotDisabled();
    error BadSignatureCount(uint256 count);
    error BadHotSignature();
    error BadScope(uint256 allowedScope);
    error SelfPayDisabled();
    error BadPayFrame();
    error TooManyFrames(uint256 count, uint256 max);
    error BadFrameBefore(uint256 index);
    error BadSenderFrame(uint256 index);
    error NoSenderFrame();
    error FrozenOnlyClear();
    error DeclaredOverPerTxMax(uint256 declared, uint256 max);
    error FeeTooHigh();
    error BlobsNotAllowed();

    // Hot execution.
    error OnlySelf();
    error Reentrancy();
    error HotFrozen();
    error BunkerActive();
    error BadCallCount(uint256 count);
    error NotAllowed(address target, bytes4 selector);
    error TokenNotAllowed(address token);
    error TransferFailed(address token);
    error CallFailed(uint256 index, bytes reason);
    error DeclaredUsdExceeded(uint256 actual, uint256 declared);
    error PerTxMaxExceeded(uint256 actual, uint256 max);
    error SessionAllowanceExceeded(bytes32 sessionId, uint256 used, uint256 allowance);
    error StandingApproval(address token, address spender);
    error NotInHotBatch();
    error BadExpiry();
    error FreezeNotExpired(uint48 until);
    error NotFrozen();

    // Roles and timelock.
    error Unauthorized();
    error MustQueue();
    error VaultOverDailyThreshold(uint256 usd, uint256 available);
    error RotationPending();
    error NoRotationPending();
    error RotationNotReady(uint48 eta);
    error BunkerNeedsRecovery();
    error BadAddress(address a);
    error BadOp(bytes32 opId);
    error OpNotReady(bytes32 opId, uint48 eta);
    error PayloadMismatch();
    error BadKind(uint8 kind);
    error GuardianCooldown(uint48 nextAt);
    error TooManyTokens();
    error BadConfig();
    error UpgradeNotAuthorized();
}
