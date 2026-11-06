// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {RollingCap} from "../lib/RollingCap.sol";
import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {IERC7579Module, IERC7579Execution, MODULE_TYPE_EXECUTOR} from "./interfaces/IERC7579Modules.sol";
import {ILeakedModules} from "./interfaces/ILeakedModules.sol";
import {LeakedPolicyHook, ILeakedRoleContext} from "./LeakedPolicyHook.sol";

/// @title LeakedRoleExecutor
/// @notice ERC-7579 executor (type 2): the 4337-backend analogue of `PQRoleSigner` plus the account's role surface
///         (plan `10-contracts.md` §10.4.2, mirroring §10.3.2's vault / recovery / guardian rules). Anyone may
///         submit; the authority is a post-quantum signature verified **in execution** through `IPQVerifier`
///         (SPHINCS- C13 by default), over an EIP-712 digest of this contract's domain. There is no ERC-4337
///         validation-gas question: a relayer (an EOA or any 4337 account) only pays for the call.
///
///         - vault (`vaultPk`): `vaultExec` runs a batch now if it fits the daily instant allowance (a rolling bucket
///           whose cap is the timelock threshold; debit = max(declared `usdValue`, measured outflow)) and loosens
///           nothing; `vaultQueue` + `executeQueued` (anyone, after `timelockDelay`) for the rest. A batch mixes
///           spends (run through the account's `executeFromExecutor`) and config calls: calls to the policy hook's
///           setters and to this contract's role setters are made directly, with `account` as first argument;
///           tightening is instant, loosening (and anything targeting the account itself, e.g. module changes)
///           must be queued;
///         - recovery (`recoveryPk`): cancels any queued op, starts a 7-day vault rotation the vault cannot cancel,
///           during which the hot tier is frozen and the vault can neither spend, queue nor execute queued ops;
///           older ops are void after the rotation (vault epoch);
///         - guardians (addresses): `guardianFreeze`, once per 7 days each, 72 h.
///         Separate nonce lanes for vault and recovery, so the vault cannot burn recovery's nonces.
contract LeakedRoleExecutor is IERC7579Module, ILeakedModules, ILeakedRoleContext, EIP712 {
    using RollingCap for RollingCap.Bucket;

    uint256 public constant MAX_VAULT_CALLS = 16;
    uint48 public constant GUARDIAN_FREEZE = 72 hours;
    uint48 public constant GUARDIAN_COOLDOWN = 7 days;
    uint48 public constant ROTATION_DELAY = 7 days;
    uint48 public constant DEFAULT_TIMELOCK = 48 hours;
    uint48 public constant MIN_TIMELOCK = 1 hours;
    uint48 public constant MAX_TIMELOCK = 30 days;
    uint8 public constant KIND_SPEND = 0;
    uint8 public constant KIND_LOOSEN = 1;

    /// Plan §10.11: `keccak256("VaultExec(address account,uint256 nonce,bytes32 callsHash,uint256 usdValue)")`.
    bytes32 public constant VAULT_EXEC_TYPEHASH =
        keccak256("VaultExec(address account,uint256 nonce,bytes32 callsHash,uint256 usdValue)");
    bytes32 public constant VAULT_QUEUE_TYPEHASH =
        keccak256("VaultQueue(address account,uint256 nonce,bytes32 callsHash,uint8 kind)");
    bytes32 public constant VAULT_CANCEL_TYPEHASH = keccak256("VaultCancel(address account,uint256 nonce,bytes32 opId)");
    bytes32 public constant RECOVERY_CANCEL_TYPEHASH =
        keccak256("RecoveryCancel(address account,uint256 nonce,bytes32 opId)");
    bytes32 public constant RECOVERY_ROTATE_TYPEHASH =
        keccak256("RecoveryRotate(address account,uint256 nonce,bytes32 newVaultPk)");
    bytes32 public constant RECOVERY_CANCEL_ROTATION_TYPEHASH =
        keccak256("RecoveryCancelRotation(address account,uint256 nonce)");

    /// ERC-7579 mode: single call, default exec type.
    bytes32 private constant MODE_SINGLE = bytes32(0);

    // Transient context (EIP-1153): the account a role action is running for, and whether it is a queued op.
    bytes32 private constant T_CTX_ACCOUNT = keccak256("leaked.executor.t.account");
    bytes32 private constant T_CTX_QUEUED = keccak256("leaked.executor.t.queued");

    struct Roles {
        LeakedPolicyHook hook;
        uint48 timelockDelay;
        uint32 vaultEpoch;
        bool initialized;
        IPQVerifier verifier;
        uint64 vaultNonce;
        uint64 recoveryNonce;
        uint48 pendingVaultEta;
        /// `verifier.sigLength()` at install (fixed-length schemes only): the role identity is (verifier, pk,
        /// sigLength), as a `PQRoleSigner` clone's immutable args; a witness of any other length is refused.
        uint32 sigLength;
        bytes32 vaultPk;
        bytes32 recoveryPk;
        bytes32 pendingVaultPk;
        RollingCap.Bucket vaultBucket;
        uint256 opNonce;
    }

    mapping(address account => Roles) internal _roles;
    mapping(address account => mapping(bytes32 opId => QueuedOp)) internal _queue;
    mapping(address account => mapping(address guardian => GuardianCfg)) internal _guardians;

    constructor() EIP712("LeakedRoleExecutor", "1") {}

    // ---------------------------------------------------------------------------------------- ERC-7579 ------

    function onInstall(bytes calldata data) external {
        address account = msg.sender;
        Roles storage r = _roles[account];
        if (r.initialized) revert AlreadyInitialized(account);
        ExecutorInit memory c = abi.decode(data, (ExecutorInit));
        if (address(c.hook).code.length == 0 || LeakedPolicyHook(c.hook).EXECUTOR() != address(this)) {
            revert BadAddress(c.hook);
        }
        if (c.verifier.code.length == 0) revert BadAddress(c.verifier);
        uint256 sigLen = _sigLength(c.verifier);
        if (sigLen == 0) revert BadConfig();
        if (c.vaultPk == bytes32(0)) revert BadConfig();
        if (c.vaultPk == c.recoveryPk) revert SameRoleKey();
        uint48 delay = c.timelockDelay == 0 ? DEFAULT_TIMELOCK : c.timelockDelay;
        if (delay < MIN_TIMELOCK || delay > MAX_TIMELOCK) revert BadConfig();

        r.initialized = true;
        r.hook = LeakedPolicyHook(c.hook);
        r.verifier = IPQVerifier(c.verifier);
        r.sigLength = uint32(sigLen);
        r.vaultPk = c.vaultPk;
        r.recoveryPk = c.recoveryPk;
        r.timelockDelay = delay;
        r.vaultBucket.init(c.timelockThresholdUsd);
        emit VaultBound(account, c.vaultPk, c.verifier, sigLen);
        emit TimelockUpdated(account, delay, c.timelockThresholdUsd);
        if (c.recoveryPk != bytes32(0)) emit RecoveryKeySet(account, c.recoveryPk);
        for (uint256 i; i < c.guardians.length; ++i) {
            address g = c.guardians[i];
            if (g == address(0) || g == account) revert BadAddress(g);
            _guardians[account][g].enabled = true;
            emit GuardianSet(account, g, true);
        }
    }

    /// Only as part of a queued (timelocked) vault op of this account.
    function onUninstall(bytes calldata) external {
        if (!isQueuedContext(msg.sender)) revert Unauthorized();
        _roles[msg.sender].initialized = false;
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR;
    }

    function isInitialized(address account) external view returns (bool) {
        return _roles[account].initialized;
    }

    // ------------------------------------------------------------------------------------------- vault ------

    /// @notice Runs a vault batch now: it must loosen nothing and its USD value (max of `usdValue` and the measured
    ///         outflow of priced assets) must fit the daily instant allowance; otherwise queue it.
    function vaultExec(address account, Call[] calldata calls, uint256 usdValue, uint256 nonce, bytes calldata pqSig)
        external
    {
        Roles storage r = _active(account);
        if (r.pendingVaultEta != 0) revert RotationPending();
        _checkCount(calls.length);
        _useVaultNonce(r, nonce);
        _verify(r, r.vaultPk, hashVaultExec(account, nonce, calls, usdValue), pqSig);

        _enter(r, account, false);
        uint256[] memory start = _snapshot(r, account);
        _run(r, account, calls, false);
        uint256 out = _outflowUsd(r, account, start);
        _exit();

        uint256 debit = out > usdValue ? out : usdValue;
        uint256 avail = r.vaultBucket.availableNow();
        if (debit > avail) revert VaultOverDailyThreshold(debit, avail);
        r.vaultBucket.spend(debit);
        emit VaultExecuted(account, debit, r.vaultBucket.available, calls.length);
    }

    /// @notice Queues a vault batch (`KIND_SPEND` for large spends, `KIND_LOOSEN` for config loosening and
    ///         module changes), executable by anyone after `timelockDelay`.
    function vaultQueue(address account, Call[] calldata calls, uint8 kind, uint256 nonce, bytes calldata pqSig)
        external
        returns (bytes32 opId)
    {
        Roles storage r = _active(account);
        if (r.pendingVaultEta != 0) revert RotationPending();
        if (kind > KIND_LOOSEN) revert BadKind(kind);
        _checkCount(calls.length);
        _useVaultNonce(r, nonce);
        _verify(r, r.vaultPk, hashVaultQueue(account, nonce, calls, kind), pqSig);
        for (uint256 i; i < calls.length; ++i) {
            _checkShape(r, account, calls[i]);
        }
        bytes32 h = callsHash(calls);
        opId = keccak256(abi.encode(account, r.opNonce++, kind, h));
        uint48 eta = uint48(block.timestamp) + r.timelockDelay;
        _queue[account][opId] = QueuedOp(eta, kind, OpState.PENDING, r.vaultEpoch, h);
        emit Queued(account, opId, kind, eta);
    }

    /// @notice Executes a queued op after its eta. Permissionless; runs with vault authority, loosening allowed.
    function executeQueued(address account, bytes32 opId, Call[] calldata calls) external {
        Roles storage r = _active(account);
        QueuedOp storage op = _queue[account][opId];
        if (op.state != OpState.PENDING || op.vaultEpoch != r.vaultEpoch) revert BadOp(opId);
        if (r.pendingVaultEta != 0) revert RotationPending();
        if (block.timestamp < op.eta) revert OpNotReady(opId, op.eta);
        if (callsHash(calls) != op.callsHash) revert PayloadMismatch();
        op.state = OpState.EXECUTED;
        _enter(r, account, true);
        _run(r, account, calls, true);
        _exit();
        emit QueueExecuted(account, opId);
    }

    /// @notice Cancels one of the vault's own pending ops (current epoch).
    function vaultCancel(address account, bytes32 opId, uint256 nonce, bytes calldata pqSig) external {
        Roles storage r = _active(account);
        _useVaultNonce(r, nonce);
        _verify(r, r.vaultPk, _hashTyped(abi.encode(VAULT_CANCEL_TYPEHASH, account, nonce, opId)), pqSig);
        QueuedOp storage op = _queue[account][opId];
        if (op.state != OpState.PENDING || op.vaultEpoch != r.vaultEpoch) revert BadOp(opId);
        op.state = OpState.CANCELLED;
        emit QueueCancelled(account, opId, false);
    }

    // ---------------------------------------------------------------------------------------- recovery ------

    /// @notice Cancels any pending op, whatever its epoch (I-4: recovery outranks the vault).
    function recoveryCancel(address account, bytes32 opId, uint256 nonce, bytes calldata pqSig) external {
        Roles storage r = _activeRecovery(account);
        _useRecoveryNonce(r, nonce);
        _verify(r, r.recoveryPk, _hashTyped(abi.encode(RECOVERY_CANCEL_TYPEHASH, account, nonce, opId)), pqSig);
        QueuedOp storage op = _queue[account][opId];
        if (op.state != OpState.PENDING) revert BadOp(opId);
        op.state = OpState.CANCELLED;
        emit QueueCancelled(account, opId, true);
    }

    /// @notice Starts (or restarts) a 7-day vault rotation the vault cannot cancel; freezes the hot tier until then.
    function recoveryStartVaultRotation(address account, bytes32 newVaultPk, uint256 nonce, bytes calldata pqSig)
        external
    {
        Roles storage r = _activeRecovery(account);
        _useRecoveryNonce(r, nonce);
        _verify(r, r.recoveryPk, _hashTyped(abi.encode(RECOVERY_ROTATE_TYPEHASH, account, nonce, newVaultPk)), pqSig);
        if (newVaultPk == bytes32(0) || newVaultPk == r.vaultPk) revert BadConfig();
        if (newVaultPk == r.recoveryPk) revert SameRoleKey();
        uint48 eta = uint48(block.timestamp) + ROTATION_DELAY;
        r.pendingVaultPk = newVaultPk;
        r.pendingVaultEta = eta;
        emit VaultRotationStarted(account, newVaultPk, eta);
        r.hook.freeze(account, eta);
    }

    function recoveryCancelVaultRotation(address account, uint256 nonce, bytes calldata pqSig) external {
        Roles storage r = _activeRecovery(account);
        if (r.pendingVaultEta == 0) revert NoRotationPending();
        _useRecoveryNonce(r, nonce);
        _verify(r, r.recoveryPk, _hashTyped(abi.encode(RECOVERY_CANCEL_ROTATION_TYPEHASH, account, nonce)), pqSig);
        bytes32 pending = r.pendingVaultPk;
        delete r.pendingVaultPk;
        delete r.pendingVaultEta;
        emit VaultRotationCancelled(account, pending);
    }

    /// @notice Completes a rotation after its eta. Permissionless. Ops queued by the old vault become void.
    function recoveryFinalizeVaultRotation(address account) external {
        Roles storage r = _active(account);
        uint48 eta = r.pendingVaultEta;
        if (eta == 0) revert NoRotationPending();
        if (block.timestamp < eta) revert RotationNotReady(eta);
        bytes32 pk = r.pendingVaultPk;
        r.vaultPk = pk;
        r.vaultEpoch += 1;
        delete r.pendingVaultPk;
        delete r.pendingVaultEta;
        emit VaultRotationFinalized(account, pk);
        // The rotation's own freeze ends now; a longer one (vault-indefinite, a later guardian's) stays.
        r.hook.releaseExpiredFreeze(account);
    }

    // ---------------------------------------------------------------------------------------- guardian ------

    /// @notice Pauses the hot tier for 72 h; each guardian once per 7 days.
    function guardianFreeze(address account) external {
        Roles storage r = _active(account);
        GuardianCfg storage g = _guardians[account][msg.sender];
        if (!g.enabled) revert Unauthorized();
        uint48 now48 = uint48(block.timestamp);
        if (g.lastFreezeAt != 0 && now48 < g.lastFreezeAt + GUARDIAN_COOLDOWN) {
            revert GuardianCooldown(g.lastFreezeAt + GUARDIAN_COOLDOWN);
        }
        g.lastFreezeAt = now48;
        r.hook.freeze(account, now48 + GUARDIAN_FREEZE);
    }

    // ------------------------------------------------- role setters (only as calls of a vault batch) ------

    /// Adds or removes a guardian (freeze-only power); instant both ways.
    function setGuardian(address account, address guardian, bool enabled) external {
        _authSelf(account, false);
        if (guardian == address(0) || guardian == account) revert BadAddress(guardian);
        _guardians[account][guardian].enabled = enabled;
        emit GuardianSet(account, guardian, enabled);
    }

    /// Timelock delay and daily instant-spend allowance. Longer delay / lower threshold is instant.
    function setTimelock(address account, uint48 delay, uint256 thresholdUsd) external {
        Roles storage r = _roles[account];
        _authSelf(account, delay < r.timelockDelay || thresholdUsd > r.vaultBucket.cap);
        if (delay < MIN_TIMELOCK || delay > MAX_TIMELOCK) revert BadConfig();
        r.timelockDelay = delay;
        r.vaultBucket.setCap(thresholdUsd);
        emit TimelockUpdated(account, delay, thresholdUsd);
    }

    /// Recovery key. The first install (from none) is instant; any change or removal is queued.
    function setRecoveryKey(address account, bytes32 pk) external {
        Roles storage r = _roles[account];
        _authSelf(account, !(r.recoveryPk == bytes32(0) && pk != bytes32(0)));
        // Role independence (the account's `SameRoleKey`): never the vault's key, nor a pending vault's (the rotation
        // would otherwise finalize into a vault and a recovery holding one key).
        if (pk != bytes32(0) && (pk == r.vaultPk || pk == r.pendingVaultPk)) revert SameRoleKey();
        if (pk == bytes32(0)) {
            (,, bool bunker) = r.hook.getFreeze(account);
            if (bunker) revert BunkerNeedsRecovery();
        }
        r.recoveryPk = pk;
        emit RecoveryKeySet(account, pk);
    }

    // ------------------------------------------------------------------------------- ILeakedRoleContext ------

    function isQueuedContext(address account) public view returns (bool) {
        return _tloadAddr(T_CTX_ACCOUNT) == account && account != address(0) && _tload(T_CTX_QUEUED) != 0;
    }

    function rotationPending(address account) external view returns (bool) {
        return _roles[account].pendingVaultEta != 0;
    }

    function hasRecovery(address account) external view returns (bool) {
        return _roles[account].recoveryPk != bytes32(0);
    }

    function isGuardian(address account, address who) external view returns (bool) {
        return _guardians[account][who].enabled;
    }

    // ---------------------------------------------------------------------------------------- digests ------

    function callsHash(Call[] calldata calls) public pure returns (bytes32) {
        return keccak256(abi.encode(calls));
    }

    function hashVaultExec(address account, uint256 nonce, Call[] calldata calls, uint256 usdValue)
        public
        view
        returns (bytes32)
    {
        return _hashTyped(abi.encode(VAULT_EXEC_TYPEHASH, account, nonce, callsHash(calls), usdValue));
    }

    function hashVaultQueue(address account, uint256 nonce, Call[] calldata calls, uint8 kind)
        public
        view
        returns (bytes32)
    {
        return _hashTyped(abi.encode(VAULT_QUEUE_TYPEHASH, account, nonce, callsHash(calls), kind));
    }

    function hashVaultCancel(address account, uint256 nonce, bytes32 opId) external view returns (bytes32) {
        return _hashTyped(abi.encode(VAULT_CANCEL_TYPEHASH, account, nonce, opId));
    }

    function hashRecoveryCancel(address account, uint256 nonce, bytes32 opId) external view returns (bytes32) {
        return _hashTyped(abi.encode(RECOVERY_CANCEL_TYPEHASH, account, nonce, opId));
    }

    function hashRecoveryRotate(address account, uint256 nonce, bytes32 newVaultPk) external view returns (bytes32) {
        return _hashTyped(abi.encode(RECOVERY_ROTATE_TYPEHASH, account, nonce, newVaultPk));
    }

    function hashRecoveryCancelRotation(address account, uint256 nonce) external view returns (bytes32) {
        return _hashTyped(abi.encode(RECOVERY_CANCEL_ROTATION_TYPEHASH, account, nonce));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ------------------------------------------------------------------------------------------ views ------

    function getRoles(address account)
        external
        view
        returns (
            address hook,
            address verifier,
            bytes32 vaultPk,
            bytes32 recoveryPk,
            uint256 vaultNonce,
            uint256 recoveryNonce,
            uint32 vaultEpoch,
            bytes32 pendingVaultPk,
            uint48 pendingVaultEta
        )
    {
        Roles storage r = _roles[account];
        return (
            address(r.hook),
            address(r.verifier),
            r.vaultPk,
            r.recoveryPk,
            r.vaultNonce,
            r.recoveryNonce,
            r.vaultEpoch,
            r.pendingVaultPk,
            r.pendingVaultEta
        );
    }

    /// The PQ verifier's fixed witness length bound at install (0 before install).
    function sigLengthOf(address account) external view returns (uint256) {
        return _roles[account].sigLength;
    }

    function getVaultBucket(address account) external view returns (uint256 available, uint256 cap, uint48 delay) {
        Roles storage r = _roles[account];
        return (r.vaultBucket.availableNow(), r.vaultBucket.cap, r.timelockDelay);
    }

    function getQueued(address account, bytes32 opId) external view returns (QueuedOp memory) {
        return _queue[account][opId];
    }

    function getGuardian(address account, address guardian) external view returns (GuardianCfg memory) {
        return _guardians[account][guardian];
    }

    // --------------------------------------------------------------------------------------- internals ------

    /// Runs a vault batch: hook setters and role setters directly, everything else through the account.
    function _run(Roles storage r, address account, Call[] calldata calls, bool queued) internal {
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            _checkShape(r, account, c);
            bool ok;
            bytes memory ret;
            if (c.target == address(r.hook) || c.target == address(this)) {
                (ok, ret) = c.target.call(c.data);
            } else {
                if (c.target == account && !queued) revert MustQueue();
                (ok, ret) = account.call(
                    abi.encodeCall(
                        IERC7579Execution.executeFromExecutor,
                        (MODE_SINGLE, abi.encodePacked(c.target, c.value, c.data))
                    )
                );
            }
            if (!ok) revert CallFailed(i, ret);
        }
    }

    /// Config calls name the account they act on as their first argument, and only the setters are reachable.
    function _checkShape(Roles storage r, address account, Call calldata c) internal view {
        if (c.target != address(r.hook) && c.target != address(this)) return;
        bytes calldata d = c.data;
        if (c.value != 0 || d.length < 36 || address(uint160(uint256(bytes32(d[4:36])))) != account) {
            revert NotAllowed(c.target, d.length >= 4 ? bytes4(d[0:4]) : bytes4(0));
        }
        bytes4 sel = bytes4(d[0:4]);
        bool allowed = c.target == address(this)
            ? (sel == this.setGuardian.selector || sel == this.setTimelock.selector || sel == this.setRecoveryKey.selector)
            : (
                sel == LeakedPolicyHook.setHotKey.selector || sel == LeakedPolicyHook.setCap.selector
                    || sel == LeakedPolicyHook.setToken.selector || sel == LeakedPolicyHook.setTarget.selector
                    || sel == LeakedPolicyHook.setSession.selector || sel == LeakedPolicyHook.setValueVerifier.selector
                    || sel == LeakedPolicyHook.setTrustedVerifier.selector || sel == LeakedPolicyHook.setRecipientMode.selector
                    || sel == LeakedPolicyHook.freeze.selector || sel == LeakedPolicyHook.unfreeze.selector
                    || sel == LeakedPolicyHook.enableBunker.selector
            );
        if (!allowed) revert NotAllowed(c.target, sel);
    }

    function _snapshot(Roles storage r, address account) internal view returns (uint256[] memory bals) {
        address[] memory list = r.hook.monitoredTokens(account);
        bals = new uint256[](list.length + 1);
        bals[0] = account.balance;
        for (uint256 i; i < list.length; ++i) {
            bals[i + 1] = _balanceOf(list[i], account);
        }
    }

    /// USD value of priced assets that left the account. An outflow of unpriced ETH must be queued.
    function _outflowUsd(Roles storage r, address account, uint256[] memory before)
        internal
        view
        returns (uint256 usd)
    {
        LeakedPolicyHook hook = r.hook;
        uint256 ethNow = account.balance;
        if (before[0] > ethNow) {
            if (!hook.getToken(account, address(0)).allowed) revert MustQueue();
            usd += hook.quoteUsd(account, address(0), before[0] - ethNow);
        }
        address[] memory list = hook.monitoredTokens(account);
        for (uint256 i; i < list.length && i + 1 < before.length; ++i) {
            uint256 bal = _balanceOf(list[i], account);
            if (before[i + 1] > bal && hook.getToken(account, list[i]).allowed) {
                usd += hook.quoteUsd(account, list[i], before[i + 1] - bal);
            }
        }
    }

    function _balanceOf(address token, address account) internal view returns (uint256 bal) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        if (ok && ret.length >= 32) bal = abi.decode(ret, (uint256));
    }

    function _verify(Roles storage r, bytes32 pk, bytes32 digest, bytes calldata sig) internal view {
        if (sig.length != r.sigLength) revert BadSignature();
        (bool ok, bytes memory ret) =
            address(r.verifier).staticcall(abi.encodeCall(IPQVerifier.verify, (pk, digest, sig)));
        if (!ok || ret.length != 32 || abi.decode(ret, (uint256)) != 1) revert BadSignature();
    }

    /// `verifier.sigLength()` under `RoleSignerFactory`'s acceptance rule (answers, 1..65535), else 0.
    function _sigLength(address verifier) internal view returns (uint256 len) {
        (bool ok, bytes memory ret) = verifier.staticcall(abi.encodeCall(IPQVerifier.sigLength, ()));
        if (ok && ret.length >= 32) len = abi.decode(ret, (uint256));
        if (len > type(uint16).max) len = 0;
    }

    function _hashTyped(bytes memory structEncoding) internal view returns (bytes32) {
        return _hashTypedDataV4(keccak256(structEncoding));
    }

    function _useVaultNonce(Roles storage r, uint256 nonce) internal {
        if (nonce != r.vaultNonce) revert BadNonce(r.vaultNonce, nonce);
        r.vaultNonce += 1;
    }

    function _useRecoveryNonce(Roles storage r, uint256 nonce) internal {
        if (nonce != r.recoveryNonce) revert BadNonce(r.recoveryNonce, nonce);
        r.recoveryNonce += 1;
    }

    function _active(address account) internal view returns (Roles storage r) {
        r = _roles[account];
        if (!r.initialized) revert NotInitialized(account);
    }

    function _activeRecovery(address account) internal view returns (Roles storage r) {
        r = _active(account);
        if (r.recoveryPk == bytes32(0)) revert Unauthorized();
    }

    function _checkCount(uint256 n) internal pure {
        if (n == 0 || n > MAX_VAULT_CALLS) revert BadCallCount(n);
    }

    /// Role setters: only from inside this executor's own batch for `account`; loosening only when queued.
    function _authSelf(address account, bool loosening) internal view {
        if (msg.sender != address(this) || _tloadAddr(T_CTX_ACCOUNT) != account) revert Unauthorized();
        if (loosening && _tload(T_CTX_QUEUED) == 0) revert MustQueue();
    }

    function _enter(Roles storage r, address account, bool queued) internal {
        if (_tloadAddr(T_CTX_ACCOUNT) != address(0) || r.hook.inHotBatch(account)) revert Reentrancy();
        _tstore(T_CTX_ACCOUNT, uint256(uint160(account)));
        _tstore(T_CTX_QUEUED, queued ? 1 : 0);
    }

    function _exit() internal {
        _tstore(T_CTX_ACCOUNT, 0);
        _tstore(T_CTX_QUEUED, 0);
    }

    function _tload(bytes32 slot) private view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }

    function _tloadAddr(bytes32 slot) private view returns (address) {
        return address(uint160(_tload(slot)));
    }

    function _tstore(bytes32 slot, uint256 v) private {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }
}
