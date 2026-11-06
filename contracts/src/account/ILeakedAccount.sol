// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ILeakedAccount
/// @notice Types, events and errors of the LEAKED frame-native account (`LeakedAccountImpl`). Names follow
///         `docs/plan/sections/10-contracts.md` §10.3.2 / §10.11. Deviations from that text:
///         - role entry points live in `LeakedAccountRoles`, DELEGATECALLed from the implementation's fallback
///           (EIP-170: one contract was 30.6 KB); unknown selectors still revert;
///         - `initialize(InitConfig)` (adds tank, ETH price, priority-fee bound, timelock fields); the tank is
///           allowlisted as a hot recipient at initialize (UX decision);
///         - bound role signers (2026-11-06): `InitConfig` carries the vault's (and optionally the recovery's) PQ
///           parameters and `initialize` DERIVES the signer address as
///           `roleSignerFactory.predictRoleSigner(salt, role, address(this), pk, verifier, payerKey)`, so the
///           account's CREATE2 address commits to the vault pk (through the init data) and the bound signer commits
///           to the account: no cycle, both counterfactual; the clone is deployed lazily by anyone (deterministic).
///           Explicit signer addresses (unbound `PQRoleSigner`, or any contract) remain accepted when no PQ
///           parameters are given (backward compatibility);
///         - recipient policy (2026-11-06, product decision): `RecipientMode.Open` (the default at initialize) lets
///           the hot key send ETH and allowlisted (priced) ERC-20s by `transfer` to ANY recipient, within the bucket
///           and the per-tx bound; `Strict` is the plan's recipient allowlist. Open -> Strict is instant
///           (`vaultSetRecipientMode`, vault only), Strict -> Open is a queued loosening. Everything else on the hot
///           path (non-transfer calls: sessions only; token: allowlisted and priced; I-6) is mode-independent, and
///           VERIFY does not read the mode;
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
///         - role independence (2026-11-06 hardening): the vault and recovery signers must hold different PQ public
///           keys (`SameRoleKey`; checked from the init parameters, else from a deployed signer's `pk()`) and be
///           distinct from each other, the account, the hot key and the tank (`BadAddress`), at initialize and on
///           every later install (recovery install/change, vault rotation, hot-key rotation, tank change);
///         - hot recipients (2026-11-06 hardening): an ETH send or token `transfer` never pays the account itself,
///           a role signer or (a `transfer`) the token itself, in either mode; an Open-mode recipient that is not
///           allowlisted is also never the tank, a guardian or an allowlisted token (`ForbiddenRecipient`). The
///           tank's top-up path is its allowlist entry (set at initialize) and keeps working;
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

    /// Who may receive a hot-key ETH send or token `transfer`. Open: anyone (the bucket and per-tx bound still
    /// apply); Strict: only the vault's recipient allowlist (`vaultSetTarget`).
    enum RecipientMode {
        Open,
        Strict
    }

    /// The `RoleSignerFactory.createRoleSigner` arguments of a bound role signer, but `role` and `account` (the
    /// account fills them in: `role` from the field, `account = address(this)`). `pk == 0` = not given.
    struct RoleSignerParams {
        bytes32 salt;
        bytes32 pk;
        address verifier;
        address payerKey;
    }

    /// Everything `initialize` sets. Zero means "default" for `maxHotFrames` (4), `timelockDelay` (48 h) and
    /// `recipientMode` (Open).
    struct InitConfig {
        address hotKey;
        /// Bound mode (the default path): the `RoleSignerFactory` the signers below are derived from.
        address roleSignerFactory;
        /// The vault's PQ parameters: `vaultSigner` is derived (`predictRoleSigner`, role 1, account = this).
        RoleSignerParams vault;
        /// Optional (`pk == 0`: none, or the explicit `recoverySigner`): derived with role 2.
        RoleSignerParams recovery;
        /// Unbound / explicit mode only (`vault.pk == 0`): the vault signer's address; must be 0 in bound mode.
        address vaultSigner;
        /// Explicit mode only (`recovery.pk == 0`); address(0) = no recovery signer yet (bunker cannot be enabled
        /// until one is installed). Must be 0 when `recovery.pk` is given.
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
        /// Open (default) or Strict (recipient allowlist only).
        RecipientMode recipientMode;
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
    /// The hot recipient policy (emitted at initialize and on every change).
    event RecipientModeSet(RecipientMode mode);

    event Frozen(address indexed by, uint48 until);
    event Unfrozen(address indexed by);
    event BunkerEnabled();
    event BunkerDisabled();

    event Queued(bytes32 indexed opId, uint8 kind, uint48 eta);
    event QueueExecuted(bytes32 indexed opId);
    event QueueCancelled(bytes32 indexed opId, address indexed by);

    event VaultSignerSet(address indexed signer);
    event RecoverySignerSet(address indexed signer);
    /// A role signer derived at initialize (bound mode): the `createRoleSigner` arguments that deploy it, so anyone
    /// can deploy the clone lazily from the log alone. Emitted before the matching `VaultSignerSet` /
    /// `RecoverySignerSet`.
    event RoleSignerDerived(
        uint8 indexed role,
        address indexed signer,
        address indexed factory,
        bytes32 salt,
        bytes32 pk,
        address verifier,
        address payerKey
    );
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
    /// A hot payment (ETH send or token `transfer`) to a self-defeating recipient: the account itself, a role
    /// signer, the token being moved, or (Open mode, not allowlisted) the tank, a guardian or an allowlisted token.
    error ForbiddenRecipient(address to);

    // Roles and timelock.
    error Unauthorized();
    error MustQueue();
    error VaultOverDailyThreshold(uint256 usd, uint256 available);
    error RotationPending();
    error NoRotationPending();
    error RotationNotReady(uint48 eta);
    error BunkerNeedsRecovery();
    error BadAddress(address a);
    /// The vault and the recovery hold the same PQ public key (recovery must be an independent key).
    error SameRoleKey();
    error BadOp(bytes32 opId);
    error OpNotReady(bytes32 opId, uint48 eta);
    error PayloadMismatch();
    error BadKind(uint8 kind);
    error GuardianCooldown(uint48 nextAt);
    error TooManyTokens();
    error BadConfig();
    error UpgradeNotAuthorized();
}
