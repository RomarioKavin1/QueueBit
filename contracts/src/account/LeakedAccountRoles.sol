// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RollingCap} from "../lib/RollingCap.sol";
import {LeakedAccountBase} from "./LeakedAccountBase.sol";
import {LeakedAccountStorage} from "./LeakedAccountStorage.sol";

/// @title LeakedAccountRoles
/// @notice The account's role surface (vault, recovery, guardian, timelock, upgrade, migration). Deployed once per
///         implementation and reached only by DELEGATECALL from `LeakedAccountImpl`'s fallback, so it runs on the
///         proxy's storage with the caller's `msg.sender` (split out of the implementation for EIP-170).
///         Spec: `docs/plan/sections/10-contracts.md` §10.3.2 ("Role entry points", access-control matrix).
///
///         Authority (`msg.sender`, never an EIP-8141 introspection read; role signers are separate senders):
///         - vault (`msg.sender == vaultSigner`): tightening instant; loosening must be queued (`MustQueue`);
///           instant spends draw on a daily allowance (cap = timelock threshold); larger ones are queued;
///         - queued ops execute permissionlessly after `eta`, with vault authority (`T_QUEUED`);
///         - recovery outranks the vault: cancels any queued op, starts a 7-day rotation the vault cannot cancel,
///           during which the hot tier is frozen and the vault can neither spend, queue nor execute;
///         - guardians: freeze only, once per 7 days each, 72 h.
contract LeakedAccountRoles is LeakedAccountBase {
    using RollingCap for RollingCap.Bucket;
    using SafeERC20 for IERC20;

    address private immutable SELF;

    error NotDelegated();

    constructor() {
        SELF = address(this);
    }

    /// Only through the account's fallback (a direct call would act on this module's own, unused storage).
    modifier delegated() {
        if (address(this) == SELF) revert NotDelegated();
        _;
    }

    // -------------------------------------------------------------------------------------- vault spends ------

    /// @notice Instant vault batch. Debit = max(declared `usdValue`, measured outflow of priced assets) from the
    ///         daily instant allowance; a larger batch reverts `VaultOverDailyThreshold` and must be queued. Calls to
    ///         the account itself are refused (config goes through the `vault*` setters).
    function vaultExecute(Call[] calldata calls, uint256 usdValue) external delegated {
        LeakedAccountStorage.Layout storage $ = _onlyVault();
        if ($.pendingVaultEta != 0) revert RotationPending();
        _noActiveContext();
        uint256 n = calls.length;
        if (n == 0 || n > MAX_VAULT_CALLS) revert BadCallCount(n);
        uint256[] memory start = _snapshot($);
        _tstore(T_VAULT, 1);
        for (uint256 i; i < n; ++i) {
            if (calls[i].target == address(this)) revert NotAllowed(address(this), _selector(calls[i].data));
            _call(i, calls[i].target, calls[i].value, calls[i].data);
        }
        _tstore(T_VAULT, 0);
        uint256 out = _outflowUsd($, start, false);
        uint256 debit = out > usdValue ? out : usdValue;
        uint256 avail = $.vaultBucket.availableNow();
        if (debit > avail) revert VaultOverDailyThreshold(debit, avail);
        $.vaultBucket.spend(debit);
        emit VaultExecuted(debit, $.vaultBucket.available, n);
    }

    /// @notice Queues a vault batch: `KIND_SPEND` (large spends) or `KIND_LOOSEN` (calls to the account's own
    ///         `vault*` setters that loosen policy). Executable by anyone after `timelockDelay`.
    function vaultQueue(Call[] calldata calls, uint8 kind) external delegated returns (bytes32 opId) {
        LeakedAccountStorage.Layout storage $ = _onlyVault();
        if ($.pendingVaultEta != 0) revert RotationPending();
        if (kind > KIND_LOOSEN) revert BadKind(kind);
        if (calls.length == 0 || calls.length > MAX_VAULT_CALLS) revert BadCallCount(calls.length);
        for (uint256 i; i < calls.length; ++i) {
            if (calls[i].target == address(this) && !_queueableSelfCall(_selector(calls[i].data))) {
                revert NotAllowed(address(this), _selector(calls[i].data));
            }
        }
        opId = _enqueue($, kind, keccak256(abi.encode(calls)));
    }

    /// @notice Executes a queued SPEND/LOOSEN op after its eta. Permissionless; runs with vault authority.
    function executeQueued(bytes32 opId, Call[] calldata calls) external delegated {
        LeakedAccountStorage.Layout storage $ = _s();
        QueuedOp storage op = _readyOp($, opId);
        if (op.kind > KIND_LOOSEN) revert BadKind(op.kind);
        if (keccak256(abi.encode(calls)) != op.payloadHash) revert PayloadMismatch();
        _noActiveContext();
        op.state = OpState.EXECUTED;
        _tstore(T_QUEUED, 1);
        for (uint256 i; i < calls.length; ++i) {
            _call(i, calls[i].target, calls[i].value, calls[i].data);
        }
        _tstore(T_QUEUED, 0);
        emit QueueExecuted(opId);
    }

    /// @notice Cancels one of the vault's own pending ops (never a recovery rotation).
    function vaultCancel(bytes32 opId) external delegated {
        LeakedAccountStorage.Layout storage $ = _onlyVault();
        QueuedOp storage op = $.queue[opId];
        if (op.state != OpState.PENDING || op.vaultEpoch != $.vaultEpoch) revert BadOp(opId);
        _cancel($, opId, op);
    }

    // ------------------------------------------------------------------------------------- vault config ------

    /// @notice Hot key rotation; instant (clears bunker).
    function vaultSetHotKey(address newHotKey) external delegated {
        LeakedAccountStorage.Layout storage $ = _authVault(false);
        if (newHotKey == address(0) || newHotKey == address(this)) revert BadAddress(newHotKey);
        address old = $.hotKey;
        $.hotKey = newHotKey;
        if ($.bunker) {
            $.bunker = false;
            emit BunkerDisabled();
        }
        emit HotKeyRotated(old, newHotKey);
    }

    /// @notice Hot limits. Tightening (every value <= current) is instant; anything else must be queued.
    function vaultSetCap(uint256 capUsdPerDay, uint256 perTxMaxUsd, uint256 maxFeeWeiPerTx, uint8 maxHotFrames)
        external
        delegated
    {
        LeakedAccountStorage.Layout storage $0 = _s();
        bool loosening = capUsdPerDay > $0.hotBucket.cap || perTxMaxUsd > $0.perTxMaxUsd
            || maxFeeWeiPerTx > $0.maxFeeWeiPerTx || maxHotFrames > $0.maxHotFrames;
        LeakedAccountStorage.Layout storage $ = _authVault(loosening);
        _checkCapBounds(perTxMaxUsd, maxFeeWeiPerTx, maxHotFrames);
        $.hotBucket.setCap(capUsdPerDay);
        $.perTxMaxUsd = uint96(perTxMaxUsd);
        $.maxFeeWeiPerTx = uint128(maxFeeWeiPerTx);
        $.maxHotFrames = maxHotFrames;
        emit CapUpdated(capUsdPerDay, perTxMaxUsd, maxFeeWeiPerTx, maxHotFrames);
    }

    /// @notice Priority-fee bound, self-pay switch and tank pin. Raising the priority bound or enabling self-pay is
    ///         loosening (queued). The pin only restricts who pays, so changing it is instant (it does not allowlist
    ///         the new tank as a recipient: that is `vaultSetTarget`).
    function vaultSetFeePolicy(uint256 maxPriorityFeePerGas, bool selfPay, address tank) external delegated {
        LeakedAccountStorage.Layout storage $0 = _s();
        bool loosening = maxPriorityFeePerGas > $0.maxPriorityFeePerGas || (selfPay && !$0.selfPay);
        LeakedAccountStorage.Layout storage $ = _authVault(loosening);
        if (maxPriorityFeePerGas > type(uint128).max) revert BadConfig();
        if (tank == address(this)) revert BadAddress(tank);
        _setFeePolicy($, maxPriorityFeePerGas, selfPay, tank);
    }

    /// @notice Token allowlist and static price (`token == address(0)` is ETH, 18 decimals). Removing a token or
    ///         raising its price is instant; adding one, lowering its price or changing decimals is queued.
    /// @param usdPerToken USD (6 decimals) per one whole token.
    function vaultSetToken(address token, bool allowed, uint8 decimals, uint256 usdPerToken) external delegated {
        TokenCfg memory cur = _s().tokens[token];
        bool loosening = allowed && (!cur.allowed || decimals != cur.decimals || usdPerToken < cur.usdPerToken);
        LeakedAccountStorage.Layout storage $ = _authVault(loosening);
        if (token == address(this)) revert BadAddress(token);
        if (allowed) {
            if (usdPerToken == 0 || decimals > 36 || (token == address(0) && decimals != 18)) revert BadConfig();
            if (!cur.allowed && token != address(0)) {
                if ($.tokenList.length >= MAX_TOKENS) revert TooManyTokens();
                $.tokenList.push(token);
            }
            $.tokens[token] = TokenCfg(true, decimals, usdPerToken);
        } else {
            if (cur.allowed && token != address(0)) _removeToken($, token);
            delete $.tokens[token];
            decimals = 0;
            usdPerToken = 0;
        }
        emit TokenConfigured(token, allowed, decimals, usdPerToken);
    }

    /// @notice Recipient allowlist for hot transfers. Adding is queued, removing instant.
    function vaultSetTarget(address target, bool allowed) external delegated {
        bool loosening = allowed && !_s().targets[target];
        LeakedAccountStorage.Layout storage $ = _authVault(loosening);
        _checkPolicyTarget($, target);
        $.targets[target] = allowed;
        emit TargetConfigured(target, allowed);
    }

    /// @notice Session policy `(target, selector, allowanceUsd, expiry)`: hot batches may call `target.selector`
    ///         while `now <= expiry`, each call debited by its measured balance delta from `allowanceUsd` and from
    ///         the hot bucket. New, raised or extended sessions are queued; lowering or removal (`allowanceUsd == 0`
    ///         or `expiry == 0`) is instant.
    function vaultSetSession(address target, bytes4 selector, uint256 allowanceUsd, uint48 expiry) external delegated {
        bytes32 sid = keccak256(abi.encodePacked(target, selector));
        Session memory cur = _s().sessions[sid];
        bool removal = allowanceUsd == 0 || expiry == 0;
        bool loosening = !removal && (allowanceUsd > cur.allowanceUsd || expiry > cur.expiry);
        LeakedAccountStorage.Layout storage $ = _authVault(loosening);
        _checkPolicyTarget($, target);
        if (removal) {
            delete $.sessions[sid];
            allowanceUsd = 0;
            expiry = 0;
        } else {
            if (expiry <= block.timestamp) revert BadExpiry();
            $.sessions[sid] = Session(allowanceUsd, expiry);
        }
        emit SessionConfigured(target, selector, allowanceUsd, expiry);
    }

    /// @notice Contracts for which a hot-key ERC-7739 signature is never valid (token permits, Permit2, order
    ///         books). Denying is instant; un-denying is queued.
    function vaultSetValueVerifier(address verifier, bool denied) external delegated {
        bool loosening = !denied && _s().valueVerifiers[verifier];
        LeakedAccountStorage.Layout storage $ = _authVault(loosening);
        $.valueVerifiers[verifier] = denied;
        emit ValueVerifierSet(verifier, denied);
    }

    /// @notice Timelock delay and daily instant-spend allowance. Longer delay / lower threshold is instant.
    function vaultSetTimelock(uint48 delay, uint256 thresholdUsd) external delegated {
        LeakedAccountStorage.Layout storage $0 = _s();
        bool loosening = delay < $0.timelockDelay || thresholdUsd > $0.vaultBucket.cap;
        LeakedAccountStorage.Layout storage $ = _authVault(loosening);
        if (delay < MIN_TIMELOCK || delay > MAX_TIMELOCK) revert BadConfig();
        $.timelockDelay = delay;
        $.vaultBucket.setCap(thresholdUsd);
        emit TimelockUpdated(delay, thresholdUsd);
    }

    /// @notice Recovery signer. The first install (from none) is instant; any change or removal is queued.
    function vaultSetRecoverySigner(address newRecoverySigner) external delegated {
        bool loosening = !(_s().recoverySigner == address(0) && newRecoverySigner != address(0));
        LeakedAccountStorage.Layout storage $ = _authVault(loosening);
        if (newRecoverySigner == address(this) || newRecoverySigner == $.vaultSigner) {
            revert BadAddress(newRecoverySigner);
        }
        if (newRecoverySigner == address(0) && $.bunker) revert BunkerNeedsRecovery();
        $.recoverySigner = newRecoverySigner;
        emit RecoverySignerSet(newRecoverySigner);
    }

    /// @notice Adds or removes a guardian (freeze-only power); instant both ways.
    function vaultSetGuardian(address guardian, bool enabled) external delegated {
        LeakedAccountStorage.Layout storage $ = _authVault(false);
        if (guardian == address(0) || guardian == address(this)) revert BadAddress(guardian);
        $.guardians[guardian].enabled = enabled;
        emit GuardianSet(guardian, enabled);
    }

    // ------------------------------------------------------------------------------------ freeze / bunker ------

    /// @notice Freezes the hot tier until the vault unfreezes it.
    function vaultFreeze() external delegated {
        _freeze(_authVault(false), type(uint48).max);
    }

    /// @notice Lifts any freeze (a guardian's included: "guardian pauses, user resumes"). Not while a recovery
    ///         rotation is pending.
    function vaultUnfreeze() external delegated {
        LeakedAccountStorage.Layout storage $ = _authVault(false);
        if ($.pendingVaultEta != 0) revert RotationPending();
        if (!$.hotFrozen) revert NotFrozen();
        $.hotFrozen = false;
        $.frozenUntil = 0;
        emit Unfrozen(msg.sender);
    }

    /// @notice Freezes the hot tier until at least `until`.
    function vaultExtendFreeze(uint48 until) external delegated {
        LeakedAccountStorage.Layout storage $ = _authVault(false);
        if (until <= block.timestamp) revert BadExpiry();
        _freeze($, until);
    }

    /// @notice Bunker: hot tier off (hot key cleared) until the vault installs a new hot key. Refused without a
    ///         recovery signer, so a lost vault never bricks a bunkered account (H6, I-7).
    function vaultEnableBunker() external delegated {
        LeakedAccountStorage.Layout storage $ = _authVault(false);
        if ($.recoverySigner == address(0)) revert BunkerNeedsRecovery();
        address old = $.hotKey;
        $.bunker = true;
        $.hotKey = address(0);
        emit BunkerEnabled();
        emit HotKeyRotated(old, address(0));
    }

    // ---------------------------------------------------------------------------------- upgrade / migrate ------

    /// @notice Queues a UUPS upgrade (replacing any pending one); executable by anyone after the delay.
    function vaultQueueUpgrade(address newImpl) external delegated returns (bytes32 opId) {
        LeakedAccountStorage.Layout storage $ = _onlyVault();
        if ($.pendingVaultEta != 0) revert RotationPending();
        if (newImpl.code.length == 0) revert BadAddress(newImpl);
        _cancelIfPending($, $.pendingUpgradeOp);
        opId = _enqueue($, KIND_UPGRADE, keccak256(abi.encode(newImpl)));
        $.pendingUpgradeOp = opId;
        $.pendingImpl = newImpl;
        emit UpgradeQueued(newImpl, $.queue[opId].eta);
    }

    function executeUpgrade(address newImpl) external delegated {
        LeakedAccountStorage.Layout storage $ = _s();
        bytes32 opId = $.pendingUpgradeOp;
        QueuedOp storage op = _readyOp($, opId);
        if (keccak256(abi.encode(newImpl)) != op.payloadHash) revert PayloadMismatch();
        _noActiveContext();
        op.state = OpState.EXECUTED;
        delete $.pendingUpgradeOp;
        delete $.pendingImpl;
        emit QueueExecuted(opId);
        // `_authorizeUpgrade` (implementation) accepts exactly this self-call while T_UPGRADE names `newImpl`.
        _tstore(T_UPGRADE, uint256(uint160(newImpl)));
        UUPSUpgradeable(address(this)).upgradeToAndCall(newImpl, "");
        _tstore(T_UPGRADE, 0);
    }

    /// @notice Queues a migration of ETH and `tokens` to `newAccount` (replacing any pending one).
    function vaultQueueMigrate(address newAccount, address[] calldata tokens)
        external
        delegated
        returns (bytes32 opId)
    {
        LeakedAccountStorage.Layout storage $ = _onlyVault();
        if ($.pendingVaultEta != 0) revert RotationPending();
        if (newAccount == address(0) || newAccount == address(this)) revert BadAddress(newAccount);
        if (tokens.length > MAX_MIGRATE_TOKENS) revert TooManyTokens();
        _cancelIfPending($, $.pendingMigrateOp);
        opId = _enqueue($, KIND_MIGRATE, keccak256(abi.encode(newAccount, tokens)));
        $.pendingMigrateOp = opId;
        emit MigrationQueued(newAccount, $.queue[opId].eta);
    }

    /// @notice Moves ETH and the listed tokens to the new account, then retires the hot tier (key cleared, frozen
    ///         indefinitely). Permissionless after the delay.
    function executeMigrate(address newAccount, address[] calldata tokens) external delegated {
        LeakedAccountStorage.Layout storage $ = _s();
        bytes32 opId = $.pendingMigrateOp;
        QueuedOp storage op = _readyOp($, opId);
        if (keccak256(abi.encode(newAccount, tokens)) != op.payloadHash) revert PayloadMismatch();
        _noActiveContext();
        op.state = OpState.EXECUTED;
        delete $.pendingMigrateOp;
        emit QueueExecuted(opId);

        address old = $.hotKey;
        $.hotKey = address(0);
        emit HotKeyRotated(old, address(0));
        _freeze($, type(uint48).max);

        for (uint256 i; i < tokens.length; ++i) {
            IERC20 t = IERC20(tokens[i]);
            uint256 bal = t.balanceOf(address(this));
            if (bal != 0) t.safeTransfer(newAccount, bal);
        }
        if (address(this).balance != 0) _call(tokens.length, newAccount, address(this).balance, "");
        emit Migrated(newAccount);
    }

    // ------------------------------------------------------------------------------------------ recovery ------

    /// @notice Cancels any pending vault op (spend, loosening, upgrade, migration), whatever its epoch.
    function recoveryCancel(bytes32 opId) external delegated {
        LeakedAccountStorage.Layout storage $ = _onlyRecovery();
        QueuedOp storage op = $.queue[opId];
        if (op.state != OpState.PENDING) revert BadOp(opId);
        _cancel($, opId, op);
    }

    /// @notice Starts (or restarts) a 7-day vault rotation the vault cannot cancel. Freezes the hot tier until the
    ///         eta; while pending the vault cannot spend, queue, execute queued ops or unfreeze.
    function recoveryStartVaultRotation(address newVaultSigner) external delegated {
        LeakedAccountStorage.Layout storage $ = _onlyRecovery();
        if (
            newVaultSigner == address(0) || newVaultSigner == address(this) || newVaultSigner == $.vaultSigner
                || newVaultSigner == $.recoverySigner
        ) revert BadAddress(newVaultSigner);
        uint48 eta = uint48(block.timestamp) + ROTATION_DELAY;
        $.pendingVaultSigner = newVaultSigner;
        $.pendingVaultEta = eta;
        emit VaultRotationStarted(newVaultSigner, eta);
        _freeze($, eta);
    }

    /// @notice Completes a rotation after its eta. Permissionless. Ops queued by the old vault become void (epoch).
    function recoveryFinalizeVaultRotation() external delegated {
        LeakedAccountStorage.Layout storage $ = _s();
        uint48 eta = $.pendingVaultEta;
        if (eta == 0) revert NoRotationPending();
        if (block.timestamp < eta) revert RotationNotReady(eta);
        address v = $.pendingVaultSigner;
        $.vaultSigner = v;
        $.vaultEpoch += 1;
        delete $.pendingVaultSigner;
        delete $.pendingVaultEta;
        delete $.pendingUpgradeOp;
        delete $.pendingImpl;
        delete $.pendingMigrateOp;
        emit VaultRotationFinalized(v);
        emit VaultSignerSet(v);
        // The rotation's own freeze ends now; a longer one (vault-indefinite, a later guardian's) stays.
        if ($.hotFrozen && $.frozenUntil <= block.timestamp) {
            $.hotFrozen = false;
            $.frozenUntil = 0;
            emit Unfrozen(msg.sender);
        }
    }

    function recoveryCancelVaultRotation() external delegated {
        LeakedAccountStorage.Layout storage $ = _onlyRecovery();
        if ($.pendingVaultEta == 0) revert NoRotationPending();
        address pending = $.pendingVaultSigner;
        delete $.pendingVaultSigner;
        delete $.pendingVaultEta;
        emit VaultRotationCancelled(pending);
    }

    // ------------------------------------------------------------------------------------------ guardian ------

    /// @notice Pauses the hot tier for 72 h; each guardian once per 7 days. VERIFY reads only the boolean.
    function guardianFreeze() external delegated {
        LeakedAccountStorage.Layout storage $ = _s();
        GuardianCfg storage g = $.guardians[msg.sender];
        if (!g.enabled) revert Unauthorized();
        uint48 now48 = uint48(block.timestamp);
        if (g.lastFreezeAt != 0 && now48 < g.lastFreezeAt + GUARDIAN_COOLDOWN) {
            revert GuardianCooldown(g.lastFreezeAt + GUARDIAN_COOLDOWN);
        }
        g.lastFreezeAt = now48;
        _freeze($, now48 + GUARDIAN_FREEZE);
    }

    // --------------------------------------------------------------------------------------------- views ------

    /// @notice The vault's daily instant-spend bucket (cap = timelock threshold) and the timelock delay.
    function getVaultBucket() external view returns (uint256 available, uint256 cap, uint48 delay) {
        LeakedAccountStorage.Layout storage $ = _s();
        return ($.vaultBucket.availableNow(), $.vaultBucket.cap, $.timelockDelay);
    }

    function isQueued(bytes32 opId) external view returns (bool) {
        return _s().queue[opId].state == OpState.PENDING;
    }

    function getQueued(bytes32 opId) external view returns (QueuedOp memory) {
        return _s().queue[opId];
    }

    function getRoles()
        external
        view
        returns (
            address vaultSigner,
            address recoverySigner,
            address pendingVaultSigner,
            uint48 pendingVaultEta,
            uint32 vaultEpoch
        )
    {
        LeakedAccountStorage.Layout storage $ = _s();
        return ($.vaultSigner, $.recoverySigner, $.pendingVaultSigner, $.pendingVaultEta, $.vaultEpoch);
    }

    function getPending() external view returns (bytes32 upgradeOp, address impl, bytes32 migrateOp) {
        LeakedAccountStorage.Layout storage $ = _s();
        return ($.pendingUpgradeOp, $.pendingImpl, $.pendingMigrateOp);
    }

    function getGuardian(address guardian) external view returns (GuardianCfg memory) {
        return _s().guardians[guardian];
    }

    function isValueVerifier(address verifier) external view returns (bool) {
        return _s().valueVerifiers[verifier];
    }

    function getTokenList() external view returns (address[] memory) {
        return _s().tokenList;
    }

    // ----------------------------------------------------------------------------------------- internals ------

    function _onlyVault() private view returns (LeakedAccountStorage.Layout storage $) {
        $ = _s();
        if (msg.sender != $.vaultSigner) revert Unauthorized();
    }

    function _onlyRecovery() private view returns (LeakedAccountStorage.Layout storage $) {
        $ = _s();
        if (msg.sender != $.recoverySigner || msg.sender == address(0)) revert Unauthorized();
    }

    /// Config setters: the vault directly (tightening only) or a queued op executing (anything).
    function _authVault(bool loosening) private view returns (LeakedAccountStorage.Layout storage $) {
        $ = _s();
        if (msg.sender == address(this) && _tload(T_QUEUED) != 0) return $;
        if (msg.sender != $.vaultSigner) revert Unauthorized();
        if (loosening) revert MustQueue();
    }

    /// The account's own setters a queued op may call (no hot path, no upgrade, no queue re-entry).
    function _queueableSelfCall(bytes4 sel) private pure returns (bool) {
        return sel == this.vaultSetHotKey.selector || sel == this.vaultSetCap.selector
            || sel == this.vaultSetFeePolicy.selector || sel == this.vaultSetToken.selector
            || sel == this.vaultSetTarget.selector || sel == this.vaultSetSession.selector
            || sel == this.vaultSetValueVerifier.selector || sel == this.vaultSetTimelock.selector
            || sel == this.vaultSetRecoverySigner.selector || sel == this.vaultSetGuardian.selector
            || sel == this.vaultFreeze.selector || sel == this.vaultUnfreeze.selector
            || sel == this.vaultExtendFreeze.selector || sel == this.vaultEnableBunker.selector;
    }

    function _enqueue(LeakedAccountStorage.Layout storage $, uint8 kind, bytes32 payloadHash)
        private
        returns (bytes32 opId)
    {
        uint256 nonce = $.opNonce++;
        opId = keccak256(abi.encode(address(this), nonce, kind, payloadHash));
        uint48 eta = uint48(block.timestamp) + $.timelockDelay;
        $.queue[opId] = QueuedOp(eta, kind, OpState.PENDING, $.vaultEpoch, payloadHash);
        emit Queued(opId, kind, eta);
    }

    function _readyOp(LeakedAccountStorage.Layout storage $, bytes32 opId) private view returns (QueuedOp storage op) {
        op = $.queue[opId];
        if (op.state != OpState.PENDING || op.vaultEpoch != $.vaultEpoch) revert BadOp(opId);
        if ($.pendingVaultEta != 0) revert RotationPending();
        if (block.timestamp < op.eta) revert OpNotReady(opId, op.eta);
    }

    function _cancel(LeakedAccountStorage.Layout storage $, bytes32 opId, QueuedOp storage op) private {
        op.state = OpState.CANCELLED;
        if ($.pendingUpgradeOp == opId) {
            delete $.pendingUpgradeOp;
            delete $.pendingImpl;
        }
        if ($.pendingMigrateOp == opId) delete $.pendingMigrateOp;
        emit QueueCancelled(opId, msg.sender);
    }

    function _cancelIfPending(LeakedAccountStorage.Layout storage $, bytes32 opId) private {
        if (opId != bytes32(0) && $.queue[opId].state == OpState.PENDING) _cancel($, opId, $.queue[opId]);
    }

    /// H2: policy targets are never address(0), the account itself or a role signer.
    function _checkPolicyTarget(LeakedAccountStorage.Layout storage $, address target) private view {
        if (target == address(0) || target == address(this) || target == $.vaultSigner || target == $.recoverySigner) {
            revert BadAddress(target);
        }
    }

    function _removeToken(LeakedAccountStorage.Layout storage $, address token) private {
        address[] storage list = $.tokenList;
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == token) {
                list[i] = list[n - 1];
                list.pop();
                return;
            }
        }
    }
}
