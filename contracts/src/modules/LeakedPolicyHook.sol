// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {RollingCap} from "../lib/RollingCap.sol";
import {IERC7579Hook, Execution, MODULE_TYPE_HOOK} from "./interfaces/IERC7579Modules.sol";
import {ILeakedModules, HOST_GENERIC, HOST_KERNEL, HOST_SAFE} from "./interfaces/ILeakedModules.sol";
import {LeakedExecDecoder} from "./lib/LeakedExecDecoder.sol";

/// Host introspection used once, at install (`LeakedPolicyHook.onInstall`).
interface IHostProbe {
    /// Safe: the owners whose `execTransaction` path bypasses every ERC-7579 hook.
    function getOwners() external view returns (address[] memory);
    /// ERC-7579 `accountId()`: "vendorname.accountname.semver".
    function accountId() external view returns (string memory);
}

/// What the hook asks the role executor (its only writer) about the current role context.
interface ILeakedRoleContext {
    /// True while the executor runs a queued (timelocked) op for `account`: loosening config is allowed.
    function isQueuedContext(address account) external view returns (bool);
    /// True while a recovery-initiated vault rotation is pending for `account`.
    function rotationPending(address account) external view returns (bool);
    /// True if `account` has a recovery key (bunker needs one, H6 / I-7).
    function hasRecovery(address account) external view returns (bool);
}

/// @title LeakedPolicyHook
/// @notice ERC-7579 hook (type 4) and the policy store of the LEAKED 4337 backend (plan `10-contracts.md` §10.4.2).
///         Holds, per account, everything the hot tier is judged by: the hot key, freeze/bunker flags, the static
///         per-tx bound and fee bounds (read by `LeakedHotValidator` during ERC-4337 validation), the rolling USD
///         bucket, token prices, recipient allowlist, sessions, registered 1271 hashes and the hot verifier rule
///         (read here in execution). Semantics mirror the frame-native account (`src/account`, §10.3.2-§10.3.5):
///         - `preCheck`/`postCheck` wrap every execution the host routes through the hook. Anything not coming
///           from `EXECUTOR` is hot: it must be an `execute(single|batch, default)` of ETH sends and allowlisted
///           (priced) ERC-20 `transfer`s to any non-zero recipient in `RecipientMode.Open` (the install default) or
///           to allowlisted recipients in Strict, vault-issued session calls (debited by
///           measured balance delta; every session called in a batch is charged the batch's whole residual outflow,
///           since a hook sees only batch-level deltas) and `registerHash`; the batch's USD value
///           (max of static debits and measured outflow, plus registered hashes) must fit `perTxMaxUsd` and the
///           rolling bucket (`RollingCap`), and no approval granted in the batch may survive it (I-6);
///         - calls from `EXECUTOR` (PQ-verified vault/recovery actions) are exempt, and so is everything nested
///           inside them (e.g. the account's own `installModule` self-call);
///         - only `EXECUTOR` writes policy; loosening needs the executor's queued (timelocked) context.
/// @dev Storage is keyed so that every slot the validator reads during ERC-4337 validation is associated with the
///      account in the ERC-7562 sense (`keccak256(account ‖ x) + n`, [STO-021]): `_policies[account]` fields sit at
///      offsets 0..5, and the nested mappings put the account last (`map[key][account]`).
contract LeakedPolicyHook is IERC7579Hook, ILeakedModules {
    using RollingCap for RollingCap.Bucket;

    uint256 public constant MAX_HOT_CALLS = 8;
    uint256 public constant MAX_TOKENS = 16;
    uint48 public constant MAX_REGISTERED_TTL = 30 days;
    /// Permit2 (same address on every chain): denied as a hot-key ERC-7739 verifier from install on.
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// The one Safe owner this hook accepts: an address nobody holds a key for. A Safe's owner path
    /// (`execTransaction`, `approveHash`, `signMessage`) never sees the ERC-7579 hook, so a keyed owner would be an
    /// unbounded second hot tier (IMPLEMENTATION-NOTES, "Contracts M7").
    address public constant KEYLESS_OWNER = 0x000000000000000000000000000000000000dEaD;

    bytes4 private constant ERC20_TRANSFER = 0xa9059cbb;
    bytes4 private constant ERC20_APPROVE = 0x095ea7b3;
    bytes4 private constant ERC20_INCREASE_ALLOWANCE = 0x39509351;
    bytes4 private constant SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    uint256 private constant KIND_PASS = 0;
    uint256 private constant KIND_HOT = 1;
    uint256 private constant KIND_EXEC = 2;
    uint256 private constant KIND_NESTED = 3;

    // Transient slots (EIP-1153), keyed per account; never touched in validation.
    bytes32 private constant T_HOT = keccak256("leaked.hook.t.hot");
    bytes32 private constant T_HOT_DEBIT = keccak256("leaked.hook.t.hotDebit");
    bytes32 private constant T_EXEC = keccak256("leaked.hook.t.exec");

    /// The `LeakedRoleExecutor` this hook trusts: the only policy writer and the only exempt caller.
    address public immutable EXECUTOR;

    struct Policy {
        // slot 0 (read in validation)
        address hotKey;
        bool initialized;
        bool frozen;
        bool bunker;
        /// Set by `onUninstall`; a retired account cannot reinstall this hook (its old allowlist would revive).
        bool retired;
        /// `HOST_*` (ILeakedModules), detected at install; read by the validator in validation and 1271.
        uint8 host;
        /// `RecipientMode.Open` when true. Stored inverted (false = Strict) so that an account whose slot was never
        /// written (or was retired) fails closed to Strict, as the account's `recipientsOpen`.
        bool recipientsOpen;
        // slot 1 (read in validation)
        uint96 perTxMaxUsd;
        uint128 maxFeeWei;
        // slot 2 (read in validation: the priority-fee bound)
        uint128 maxPriorityFeePerGas;
        uint48 frozenUntil;
        // slots 3-5 (validation reads `cap` only)
        RollingCap.Bucket bucket;
        // slot 6: allowlisted ERC-20s (not ETH) whose balance deltas are measured; execution only
        address[] tokenList;
    }

    struct Approval {
        address token;
        address spender;
        bool forAll;
    }

    mapping(address account => Policy) internal _policies;
    mapping(address token => mapping(address account => TokenCfg)) internal _tokens;
    mapping(address target => mapping(address account => bool)) internal _targets;
    mapping(bytes32 sessionId => mapping(address account => Session)) internal _sessions;
    mapping(bytes32 hash => mapping(address account => uint48 expiry)) internal _registered;
    mapping(address verifier => mapping(address account => bool)) internal _valueVerifiers;
    /// On-chain verifiers the vault vouches for (hot-key 1271 is otherwise honoured only for code-less callers).
    mapping(address verifier => mapping(address account => bool)) internal _trustedVerifiers;
    /// The one contract that may consume a registered hash (`registerPermit`: the token); 0 for `registerHash`.
    mapping(bytes32 hash => mapping(address account => address)) internal _registeredFor;

    constructor(address executor) {
        if (executor.code.length == 0) revert BadAddress(executor);
        EXECUTOR = executor;
    }

    modifier onlyExecutor() {
        if (msg.sender != EXECUTOR) revert Unauthorized();
        _;
    }

    // ---------------------------------------------------------------------------------------- ERC-7579 ------

    function onInstall(bytes calldata data) external {
        address account = msg.sender;
        Policy storage p = _policies[account];
        if (p.initialized || p.retired) revert AlreadyInitialized(account);
        HookInit memory c = abi.decode(data, (HookInit));
        if (c.hotKey == address(0) || c.hotKey == account) revert BadAddress(c.hotKey);
        _checkBounds(c.perTxMaxUsd, c.maxFeeWei, c.maxPriorityFeePerGas);

        p.initialized = true;
        p.host = _detectHost(account);
        p.hotKey = c.hotKey;
        p.perTxMaxUsd = uint96(c.perTxMaxUsd);
        p.maxFeeWei = uint128(c.maxFeeWei);
        p.maxPriorityFeePerGas = uint128(c.maxPriorityFeePerGas);
        p.bucket.init(c.capUsdPerDay);
        p.recipientsOpen = c.recipientMode == RecipientMode.Open;
        emit HotKeyRotated(account, address(0), c.hotKey);
        emit RecipientModeSet(account, c.recipientMode);
        emit CapUpdated(account, c.capUsdPerDay, c.perTxMaxUsd, c.maxFeeWei, c.maxPriorityFeePerGas);

        if (c.ethUsdPrice != 0) {
            _tokens[address(0)][account] = TokenCfg(true, 18, c.ethUsdPrice);
            emit TokenConfigured(account, address(0), true, 18, c.ethUsdPrice);
        }
        for (uint256 i; i < c.tokens.length; ++i) {
            TokenInit memory t = c.tokens[i];
            _setToken(account, p, t.token, true, t.decimals, t.usdPerToken);
        }
        for (uint256 i; i < c.targets.length; ++i) {
            _checkPolicyTarget(account, c.targets[i]);
            _targets[c.targets[i]][account] = true;
            emit TargetConfigured(account, c.targets[i], true);
        }
        _valueVerifiers[PERMIT2][account] = true;
        emit ValueVerifierSet(account, PERMIT2, true);
    }

    /// Only as part of a queued (timelocked) vault op: uninstalling the hook removes every hot limit.
    function onUninstall(bytes calldata) external {
        address account = msg.sender;
        if (_tload(T_EXEC, account) == 0 || !ILeakedRoleContext(EXECUTOR).isQueuedContext(account)) {
            revert Unauthorized();
        }
        Policy storage p = _policies[account];
        p.initialized = false;
        p.retired = true;
        p.recipientsOpen = false;
        p.hotKey = address(0);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_HOOK;
    }

    function isInitialized(address account) external view returns (bool) {
        return _policies[account].initialized;
    }

    /// @notice Classifies the execution (role executor, nested in one, or hot) and, for a hot batch, checks the
    ///         static policy and snapshots the monitored balances.
    function preCheck(address msgSender, uint256, bytes calldata msgData) external returns (bytes memory) {
        address account = msg.sender;
        uint256 depth = _tload(T_EXEC, account);
        if (depth != 0) {
            _tstore(T_EXEC, account, depth + 1);
            return abi.encode(KIND_NESTED);
        }
        Policy storage p = _policies[account];
        if (!p.initialized) revert NotInitialized(account);
        if (_tload(T_HOT, account) != 0) revert Reentrancy();
        if (msgSender == EXECUTOR) {
            _tstore(T_EXEC, account, 1);
            return abi.encode(KIND_EXEC);
        }

        if (p.bunker || p.hotKey == address(0)) revert BunkerActive();
        Execution[] memory execs = LeakedExecDecoder.decodeExecute(msgData, true);
        if (p.frozen) {
            _requireClearOnly(account, execs);
            return abi.encode(KIND_PASS);
        }
        (uint256 staticDebit,, bytes32[] memory sids) = _checkCalls(account, execs, false);
        uint256[] memory snap = _snapshot(account, p);
        Approval[] memory approvals = _collectApprovals(execs);
        _tstore(T_HOT, account, 1);
        return abi.encode(KIND_HOT, staticDebit, sids, execs.length, snap, approvals);
    }

    /// @notice Debits the hot batch: max(static debits, measured outflow) plus registered hashes, against
    ///         `perTxMaxUsd` and the rolling bucket; charges the batch's sessions; enforces I-6.
    function postCheck(bytes calldata hookData) external {
        address account = msg.sender;
        uint256 kind = abi.decode(hookData[0:32], (uint256));
        if (kind == KIND_NESTED || kind == KIND_EXEC) {
            uint256 depth = _tload(T_EXEC, account);
            if (depth == 0) revert Unauthorized();
            _tstore(T_EXEC, account, kind == KIND_EXEC ? 0 : depth - 1);
            return;
        }
        if (kind == KIND_PASS) return;
        if (kind != KIND_HOT || _tload(T_HOT, account) == 0) revert Unauthorized();

        (, uint256 staticDebit, bytes32[] memory sids, uint256 n, uint256[] memory snap, Approval[] memory approvals) =
            abi.decode(hookData, (uint256, uint256, bytes32[], uint256, uint256[], Approval[]));
        Policy storage p = _policies[account];
        uint256 out = _outflowUsd(account, p, snap);
        uint256 debit = out > staticDebit ? out : staticDebit;
        // Each session called in the batch is charged whatever left beyond the static transfers (H4). Charging every
        // one the whole residual over-counts when a batch uses several (approve + swap), which fails closed.
        uint256 used = out > staticDebit ? out - staticDebit : 0;
        for (uint256 i; i < sids.length; ++i) {
            Session storage s = _sessions[sids[i]][account];
            uint256 left = s.allowanceUsd;
            if (used > left) revert SessionAllowanceExceeded(sids[i], used, left);
            unchecked {
                left -= used;
            }
            s.allowanceUsd = left;
            emit SessionUsed(account, sids[i], used, left);
        }
        debit += _tload(T_HOT_DEBIT, account);
        if (debit > p.perTxMaxUsd) revert PerTxMaxExceeded(debit, p.perTxMaxUsd);
        p.bucket.spend(debit);
        _checkApprovals(account, approvals);
        _tstore(T_HOT, account, 0);
        _tstore(T_HOT_DEBIT, account, 0);
        emit HotExecuted(account, debit, p.bucket.available, n);
    }

    // ------------------------------------------------------------------------------------- hot entry points ------

    /// @notice Registers an opaque hash for ERC-1271, debiting `amount` of `token` (address(0) = ETH) from the hot
    ///         bucket. Only as a call of a hot batch. The debit is self-declared (the contract cannot read a hash's
    ///         value), so the hash is honoured only under the hot verifier rule (`hotVerifierAllowed`): never for a
    ///         token, Permit2 or any on-chain verifier the vault has not trusted (audit C1). Permits: `registerPermit`.
    function registerHash(bytes32 hash, address token, uint256 amount, uint48 expiry) external {
        address account = msg.sender;
        if (_tload(T_HOT, account) == 0) revert NotInHotBatch();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_REGISTERED_TTL) revert BadExpiry();
        uint256 usd = _quoteStrict(account, token, amount);
        _registered[hash][account] = expiry;
        delete _registeredFor[hash][account];
        _tstore(T_HOT_DEBIT, account, _tload(T_HOT_DEBIT, account) + usd);
        emit HashRegistered(account, hash, token, amount, expiry);
    }

    /// @notice Registers an ERC-2612 permit of `value` base units of the allowlisted `token` to `spender`: the digest
    ///         is computed here from the token's `DOMAIN_SEPARATOR()` and `nonces(account)`, the hot bucket is
    ///         debited by the permit's own value, and only `token` may consume the hash. Expires at `deadline`, at
    ///         most `MAX_REGISTERED_TTL` from now. Hot batch only (mirrors the account's audit fix C1).
    function registerPermit(address token, address spender, uint256 value, uint256 deadline) external {
        address account = msg.sender;
        if (_tload(T_HOT, account) == 0) revert NotInHotBatch();
        TokenCfg storage t = _tokens[token][account];
        if (token == address(0) || !t.allowed) revert TokenNotAllowed(token);
        if (deadline <= block.timestamp) revert BadExpiry();
        uint48 expiry = uint48(Math.min(deadline, block.timestamp + MAX_REGISTERED_TTL));
        bytes32 digest = MessageHashUtils.toTypedDataHash(
            IERC20Permit(token).DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(PERMIT_TYPEHASH, account, spender, value, IERC20Permit(token).nonces(account), deadline)
            )
        );
        _registered[digest][account] = expiry;
        _registeredFor[digest][account] = token;
        _tstore(T_HOT_DEBIT, account, _tload(T_HOT_DEBIT, account) + _quote(t, value));
        emit HashRegistered(account, digest, token, value, expiry);
    }

    /// @notice Clears an expired freeze. Permissionless (and the only hot batch the validator admits while frozen).
    function clearExpiredFreeze(address account) external {
        Policy storage p = _policies[account];
        if (!p.frozen) revert NotFrozen();
        if (ILeakedRoleContext(EXECUTOR).rotationPending(account)) revert RotationPending();
        if (block.timestamp < p.frozenUntil) revert FreezeNotExpired(p.frozenUntil);
        p.frozen = false;
        p.frozenUntil = 0;
        emit Unfrozen(account, msg.sender);
    }

    // ------------------------------------------------------------------------- policy writes (executor only) ------

    /// Hot key rotation; instant (clears bunker).
    function setHotKey(address account, address newHotKey) external onlyExecutor {
        Policy storage p = _initialized(account);
        if (newHotKey == address(0) || newHotKey == account) revert BadAddress(newHotKey);
        address old = p.hotKey;
        p.hotKey = newHotKey;
        if (p.bunker) {
            p.bunker = false;
            emit BunkerDisabled(account);
        }
        emit HotKeyRotated(account, old, newHotKey);
    }

    /// Hot limits. Tightening (every value <= current) is instant; anything else needs the queued context.
    function setCap(address account, uint256 capUsdPerDay, uint256 perTxMaxUsd, uint256 maxFeeWei, uint256 maxPrio)
        external
        onlyExecutor
    {
        Policy storage p = _initialized(account);
        bool loosening = capUsdPerDay > p.bucket.cap || perTxMaxUsd > p.perTxMaxUsd || maxFeeWei > p.maxFeeWei
            || maxPrio > p.maxPriorityFeePerGas;
        _authLoosen(account, loosening);
        _checkBounds(perTxMaxUsd, maxFeeWei, maxPrio);
        p.bucket.setCap(capUsdPerDay);
        p.perTxMaxUsd = uint96(perTxMaxUsd);
        p.maxFeeWei = uint128(maxFeeWei);
        p.maxPriorityFeePerGas = uint128(maxPrio);
        emit CapUpdated(account, capUsdPerDay, perTxMaxUsd, maxFeeWei, maxPrio);
    }

    /// Token allowlist and static price (`token == address(0)` is ETH, 18 decimals). Removing a token or raising
    /// its price is instant; adding one, lowering its price or changing decimals is queued.
    function setToken(address account, address token, bool allowed, uint8 decimals, uint256 usdPerToken)
        external
        onlyExecutor
    {
        Policy storage p = _initialized(account);
        TokenCfg memory cur = _tokens[token][account];
        bool loosening = allowed && (!cur.allowed || decimals != cur.decimals || usdPerToken < cur.usdPerToken);
        _authLoosen(account, loosening);
        _setToken(account, p, token, allowed, decimals, usdPerToken);
    }

    /// Recipient allowlist for hot transfers. Adding is queued, removing instant.
    function setTarget(address account, address target, bool allowed) external onlyExecutor {
        _initialized(account);
        _authLoosen(account, allowed && !_targets[target][account]);
        _checkPolicyTarget(account, target);
        _targets[target][account] = allowed;
        emit TargetConfigured(account, target, allowed);
    }

    /// Hot recipient policy. Open -> Strict (only `setTarget` recipients) is a tightening and instant; Strict -> Open
    /// is a loosening and must be queued. Only the vault reaches it (a role-executor vault batch; guardians can only
    /// freeze): a guardian-imposed Strict would be an open-ended, timelocked outage of everyday payments that buys
    /// nothing a freeze does not (mirrors the account's `vaultSetRecipientMode`).
    function setRecipientMode(address account, RecipientMode mode) external onlyExecutor {
        Policy storage p = _initialized(account);
        bool open = mode == RecipientMode.Open;
        _authLoosen(account, open && !p.recipientsOpen);
        p.recipientsOpen = open;
        emit RecipientModeSet(account, mode);
    }

    /// Session policy `(target, selector, allowanceUsd, expiry)`. New, raised or extended sessions are queued;
    /// lowering or removal (`allowanceUsd == 0` or `expiry == 0`) is instant.
    function setSession(address account, address target, bytes4 selector, uint256 allowanceUsd, uint48 expiry)
        external
        onlyExecutor
    {
        _initialized(account);
        bytes32 sid = sessionId(target, selector);
        Session memory cur = _sessions[sid][account];
        bool removal = allowanceUsd == 0 || expiry == 0;
        _authLoosen(account, !removal && (allowanceUsd > cur.allowanceUsd || expiry > cur.expiry));
        _checkPolicyTarget(account, target);
        if (removal) {
            delete _sessions[sid][account];
            allowanceUsd = 0;
            expiry = 0;
        } else {
            if (expiry <= block.timestamp) revert BadExpiry();
            _sessions[sid][account] = Session(allowanceUsd, expiry);
        }
        emit SessionConfigured(account, target, selector, allowanceUsd, expiry);
    }

    /// Contracts for which a hot-key ERC-7739 signature is never valid. Denying is instant; un-denying is queued.
    function setValueVerifier(address account, address verifier, bool denied) external onlyExecutor {
        _initialized(account);
        _authLoosen(account, !denied && _valueVerifiers[verifier][account]);
        _valueVerifiers[verifier][account] = denied;
        emit ValueVerifierSet(account, verifier, denied);
    }

    /// On-chain verifiers for which hot-key 1271 is honoured (audit H1). Trusting is queued; untrusting instant.
    /// The deny list and the token allowlist always win over trust.
    function setTrustedVerifier(address account, address verifier, bool trusted) external onlyExecutor {
        _initialized(account);
        _authLoosen(account, trusted && !_trustedVerifiers[verifier][account]);
        if (verifier == address(0) || verifier == account) revert BadAddress(verifier);
        _trustedVerifiers[verifier][account] = trusted;
        emit TrustedVerifierSet(account, verifier, trusted);
    }

    /// Freezes the hot tier until at least `until` (the vault passes type(uint48).max: until it unfreezes).
    function freeze(address account, uint48 until) external onlyExecutor {
        Policy storage p = _initialized(account);
        if (until <= block.timestamp) revert BadExpiry();
        p.frozen = true;
        if (until > p.frozenUntil) p.frozenUntil = until;
        emit Frozen(account, msg.sender, p.frozenUntil);
    }

    /// Lifts any freeze (the executor refuses this while a recovery rotation is pending).
    function unfreeze(address account) external onlyExecutor {
        Policy storage p = _initialized(account);
        if (!p.frozen) revert NotFrozen();
        p.frozen = false;
        p.frozenUntil = 0;
        emit Unfrozen(account, msg.sender);
    }

    /// Lifts a freeze whose time is up (end of a recovery rotation); a longer one stays. Never reverts on state.
    function releaseExpiredFreeze(address account) external onlyExecutor {
        Policy storage p = _policies[account];
        if (p.frozen && p.frozenUntil <= block.timestamp) {
            p.frozen = false;
            p.frozenUntil = 0;
            emit Unfrozen(account, msg.sender);
        }
    }

    /// Bunker: hot tier off (hot key cleared) until a new hot key is installed. Needs a recovery key (H6, I-7).
    function enableBunker(address account) external onlyExecutor {
        Policy storage p = _initialized(account);
        if (!ILeakedRoleContext(EXECUTOR).hasRecovery(account)) revert BunkerNeedsRecovery();
        address old = p.hotKey;
        p.bunker = true;
        p.hotKey = address(0);
        emit BunkerEnabled(account);
        emit HotKeyRotated(account, old, address(0));
    }

    // ------------------------------------------------------------------------------------------- views ------

    /// The validation-time subset in one call (account-associated slots only; no TIMESTAMP).
    function hotView(address account) external view returns (HotView memory v) {
        Policy storage p = _policies[account];
        v = HotView(
            p.hotKey,
            p.initialized,
            p.frozen,
            p.bunker,
            p.perTxMaxUsd,
            p.maxFeeWei,
            p.maxPriorityFeePerGas,
            p.bucket.cap,
            p.host
        );
    }

    /// @notice The static part of the hot policy, as the validator applies it during ERC-4337 validation: returns
    ///         the batch's statically known USD value (transfers + registered hashes). Reverts on any call the hot
    ///         tier may not make. Session expiry is not checked here (TIMESTAMP is banned in validation, [OP-011]);
    ///         `preCheck` checks it in execution. While frozen, only the clear-only batch passes (value 0).
    function checkHotCalls(address account, Execution[] memory execs) external view returns (uint256 usd) {
        Policy storage p = _policies[account];
        if (p.frozen) {
            _requireClearOnly(account, execs);
            return 0;
        }
        (uint256 staticDebit, uint256 registerDebit,) = _checkCalls(account, execs, true);
        return staticDebit + registerDebit;
    }

    function getBucket(address account) external view returns (uint256 available, uint48 lastUpdate, uint256 cap) {
        RollingCap.Bucket storage b = _policies[account].bucket;
        return (b.availableNow(), b.lastUpdate, b.cap);
    }

    function getFreeze(address account) external view returns (bool frozen, uint48 until, bool bunker) {
        Policy storage p = _policies[account];
        return (p.frozen, p.frozenUntil, p.bunker);
    }

    function quoteUsd(address account, address token, uint256 amount) external view returns (uint256) {
        return _quoteStrict(account, token, amount);
    }

    function getToken(address account, address token) external view returns (TokenCfg memory) {
        return _tokens[token][account];
    }

    function monitoredTokens(address account) external view returns (address[] memory) {
        return _policies[account].tokenList;
    }

    /// Strict for an account that never installed the hook (or uninstalled it): the zero slot fails closed.
    function recipientMode(address account) external view returns (RecipientMode) {
        return _policies[account].recipientsOpen ? RecipientMode.Open : RecipientMode.Strict;
    }

    function isTarget(address account, address target) external view returns (bool) {
        return _targets[target][account];
    }

    function getSession(address account, address target, bytes4 selector) external view returns (Session memory) {
        return _sessions[sessionId(target, selector)][account];
    }

    function registeredHashExpiry(address account, bytes32 hash) external view returns (uint48) {
        return _registered[hash][account];
    }

    /// Live registered hash (execution-time: reads the clock).
    function isRegistered(address account, bytes32 hash) external view returns (bool) {
        uint48 exp = _registered[hash][account];
        return exp != 0 && block.timestamp <= exp;
    }

    /// The hot verifier rule (audit H1, as the account's `_hotVerifierAllowed`): hot-key 1271 material is honoured
    /// for a code-less caller (eth_call verification: SIWE, viem's ERC-6492 path) or a vault-trusted verifier, and
    /// never for an allowlisted token or a denied value verifier (Permit2 by default).
    function hotVerifierAllowed(address account, address caller) external view returns (bool) {
        if (_valueVerifiers[caller][account] || (caller != address(0) && _tokens[caller][account].allowed)) {
            return false;
        }
        return caller.code.length == 0 || _trustedVerifiers[caller][account];
    }

    /// @notice Who may consume an opaque registered hash (`registerHash`): stricter than `hotVerifierAllowed`. The
    ///         debit of such a hash is self-declared, so it must never reach an on-chain consumer the vault has not
    ///         trusted; and a code-less `caller` is not proof of an off-chain check: hosts route state-changing
    ///         1271 checks with the original caller as sender (Safe7579 `emergencyUninstallHook` passes
    ///         `_msgSender()`), which an EOA transaction or a contract under construction satisfies. Only
    ///         `address(0)` (eth_call's default `from`; unreachable in a transaction) or a vault-trusted verifier.
    function registeredHashAllowed(address account, address caller) external view returns (bool) {
        if (_valueVerifiers[caller][account] || (caller != address(0) && _tokens[caller][account].allowed)) {
            return false;
        }
        return caller == address(0) || _trustedVerifiers[caller][account];
    }

    function isTrustedVerifier(address account, address verifier) external view returns (bool) {
        return _trustedVerifiers[verifier][account];
    }

    /// `HOST_*` of `account` (0 before install).
    function hostOf(address account) external view returns (uint8) {
        return _policies[account].host;
    }

    /// The one contract that may consume a registered hash (the token, for `registerPermit`), else address(0).
    function registeredHashConsumer(address account, bytes32 hash) external view returns (address) {
        return _registeredFor[hash][account];
    }

    function inHotBatch(address account) external view returns (bool) {
        return _tload(T_HOT, account) != 0;
    }

    function sessionId(address target, bytes4 selector) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(target, selector));
    }

    // --------------------------------------------------------------------------------------- internals ------

    /// The static hot policy over `execs`. Returns the static transfer debits, the registered-hash debits and the
    /// distinct sessions the batch calls.
    function _checkCalls(address account, Execution[] memory execs, bool validation)
        internal
        view
        returns (uint256 staticDebit, uint256 registerDebit, bytes32[] memory sids)
    {
        uint256 n = execs.length;
        if (n == 0 || n > MAX_HOT_CALLS) revert BadCallCount(n);
        bool open = _policies[account].recipientsOpen;
        sids = new bytes32[](n);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            address t = execs[i].target;
            uint256 value = execs[i].value;
            bytes memory d = execs[i].callData;
            bytes4 sel = LeakedExecDecoder.selectorOf(d);
            if (t == address(this)) {
                // The hook calls a hot batch may make (clearExpiredFreeze runs only in the frozen batch):
                // registerHash(hash, token, amount, expiry) and registerPermit(token, spender, value, deadline).
                uint256 tokenArg;
                if (sel == this.registerHash.selector) tokenArg = 1;
                else if (sel != this.registerPermit.selector) revert NotAllowed(t, sel);
                if (value != 0 || d.length != 132) revert NotAllowed(t, sel);
                bytes32 tokenWord = LeakedExecDecoder.argWord(d, tokenArg);
                if (uint256(tokenWord) >> 160 != 0) revert NotAllowed(t, sel);
                registerDebit += _quoteStrict(
                    account, address(uint160(uint256(tokenWord))), uint256(LeakedExecDecoder.argWord(d, 2))
                );
                continue;
            }
            if (t == account || t == EXECUTOR || t == address(0)) revert NotAllowed(t, sel);
            if (d.length == 0) {
                // Plain ETH: to an allowlisted recipient, or (Open) to any recipient, with value (t != 0 above). A
                // zero-value empty call moves nothing and only runs the target's fallback: it needs the allowlist.
                if (!_targets[t][account] && (value == 0 || !open)) revert NotAllowed(t, bytes4(0));
                staticDebit += _quoteStrict(account, address(0), value);
                continue;
            }
            TokenCfg storage tc = _tokens[t][account];
            if (tc.allowed && sel == ERC20_TRANSFER) {
                // ERC-20 transfer of an allowlisted (priced) token to an allowlisted recipient, or (Open) to any
                // non-zero recipient (H2: nothing else on a token: approve / permit / transferFrom need a session).
                if (value != 0 || d.length != 68) revert NotAllowed(t, sel);
                bytes32 toWord = LeakedExecDecoder.argWord(d, 0);
                address to = address(uint160(uint256(toWord)));
                if (uint256(toWord) >> 160 != 0 || (!_targets[to][account] && (to == address(0) || !open))) {
                    revert NotAllowed(to, sel);
                }
                staticDebit += _quote(tc, uint256(LeakedExecDecoder.argWord(d, 1)));
                continue;
            }
            // Session call: vault-issued (target, selector) policy, debited by measured balance delta (H4).
            bytes32 s = sessionId(t, sel);
            Session storage ss = _sessions[s][account];
            if (ss.expiry == 0 || (!validation && block.timestamp > ss.expiry)) revert NotAllowed(t, sel);
            // Audit M2: an approval is accountable only on an asset the delta accounting watches.
            if ((sel == ERC20_APPROVE || sel == ERC20_INCREASE_ALLOWANCE || sel == SET_APPROVAL_FOR_ALL) && !tc.allowed)
            {
                revert NotAllowed(t, sel);
            }
            bool seen;
            for (uint256 j; j < k; ++j) {
                if (sids[j] == s) seen = true;
            }
            if (!seen) sids[k++] = s;
        }
        assembly ("memory-safe") {
            mstore(sids, k)
        }
    }

    function _requireClearOnly(address account, Execution[] memory execs) internal view {
        if (
            execs.length != 1 || execs[0].target != address(this) || execs[0].value != 0
                || keccak256(execs[0].callData) != keccak256(abi.encodeCall(this.clearExpiredFreeze, (account)))
        ) revert FrozenOnlyClear();
    }

    function _collectApprovals(Execution[] memory execs) internal pure returns (Approval[] memory list) {
        uint256 n = execs.length;
        list = new Approval[](n);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            bytes memory d = execs[i].callData;
            if (d.length < 36) continue;
            bytes4 sel = LeakedExecDecoder.selectorOf(d);
            if (sel == ERC20_APPROVE || sel == ERC20_INCREASE_ALLOWANCE || sel == SET_APPROVAL_FOR_ALL) {
                address spender = address(uint160(uint256(LeakedExecDecoder.argWord(d, 0))));
                list[k++] = Approval(execs[i].target, spender, sel == SET_APPROVAL_FOR_ALL);
            }
        }
        assembly ("memory-safe") {
            mstore(list, k)
        }
    }

    /// I-6: no approval granted inside the batch survives it.
    function _checkApprovals(address account, Approval[] memory list) internal view {
        for (uint256 i; i < list.length; ++i) {
            Approval memory a = list[i];
            bytes memory q = a.forAll
                ? abi.encodeWithSelector(0xe985e9c5, account, a.spender) // isApprovedForAll
                : abi.encodeCall(IERC20.allowance, (account, a.spender));
            (bool ok, bytes memory ret) = a.token.staticcall(q);
            if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 0) revert StandingApproval(a.token, a.spender);
        }
    }

    /// Balances of the monitored assets: [ETH, tokenList...].
    function _snapshot(address account, Policy storage p) internal view returns (uint256[] memory bals) {
        address[] storage list = p.tokenList;
        uint256 n = list.length;
        bals = new uint256[](n + 1);
        bals[0] = account.balance;
        for (uint256 i; i < n; ++i) {
            bals[i + 1] = _balanceOf(list[i], account);
        }
    }

    /// USD value of the monitored assets that left since `before`. An outflow of unpriced ETH reverts.
    function _outflowUsd(address account, Policy storage p, uint256[] memory before)
        internal
        view
        returns (uint256 usd)
    {
        uint256 ethNow = account.balance;
        if (before[0] > ethNow) usd += _quoteStrict(account, address(0), before[0] - ethNow);
        address[] storage list = p.tokenList;
        uint256 n = list.length;
        for (uint256 i; i < n && i + 1 < before.length; ++i) {
            uint256 bal = _balanceOf(list[i], account);
            if (before[i + 1] > bal) usd += _quote(_tokens[list[i]][account], before[i + 1] - bal);
        }
    }

    function _balanceOf(address token, address account) internal view returns (uint256 bal) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (account)));
        if (ok && ret.length >= 32) bal = abi.decode(ret, (uint256));
    }

    function _quoteStrict(address account, address token, uint256 amount) internal view returns (uint256) {
        TokenCfg storage t = _tokens[token][account];
        if (!t.allowed) revert TokenNotAllowed(token);
        return _quote(t, amount);
    }

    /// USD (6 decimals, rounded up) of `amount` base units at the vault-set static price.
    function _quote(TokenCfg storage t, uint256 amount) internal view returns (uint256) {
        if (amount == 0) return 0;
        return Math.mulDiv(amount, t.usdPerToken, 10 ** t.decimals, Math.Rounding.Ceil);
    }

    function _setToken(
        address account,
        Policy storage p,
        address token,
        bool allowed,
        uint8 decimals,
        uint256 usdPerToken
    ) internal {
        if (token == account || token == address(this) || token == EXECUTOR) revert BadAddress(token);
        TokenCfg memory cur = _tokens[token][account];
        if (allowed) {
            if (usdPerToken == 0 || decimals > 36 || (token == address(0) && decimals != 18)) revert BadConfig();
            if (!cur.allowed && token != address(0)) {
                if (p.tokenList.length >= MAX_TOKENS) revert TooManyTokens();
                p.tokenList.push(token);
            }
            _tokens[token][account] = TokenCfg(true, decimals, usdPerToken);
        } else {
            if (cur.allowed && token != address(0)) _removeToken(p, token);
            delete _tokens[token][account];
            decimals = 0;
            usdPerToken = 0;
        }
        emit TokenConfigured(account, token, allowed, decimals, usdPerToken);
    }

    function _removeToken(Policy storage p, address token) internal {
        address[] storage list = p.tokenList;
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == token) {
                list[i] = list[n - 1];
                list.pop();
                return;
            }
        }
    }

    /// H2: policy targets are never address(0), the account itself or a LEAKED module.
    function _checkPolicyTarget(address account, address target) internal view {
        if (target == address(0) || target == account || target == address(this) || target == EXECUTOR) {
            revert BadAddress(target);
        }
    }

    /// Host kind, from what the account answers at install. A Safe (it has `getOwners()`) must have the keyless
    /// owner only: its owner path bypasses hooks (owner changes are `authorized` self-calls, i.e. queued vault ops
    /// afterwards). Kernel (`accountId()` "kernel.*") binds hooks per validator and rewraps 1271 hashes: the
    /// validator refuses hot 1271 there and checks the hook through the root validator's config.
    function _detectHost(address account) internal view returns (uint8) {
        (bool ok, bytes memory ret) = account.staticcall(abi.encodeCall(IHostProbe.getOwners, ()));
        if (ok && ret.length >= 64) {
            address[] memory owners = abi.decode(ret, (address[]));
            for (uint256 i; i < owners.length; ++i) {
                if (owners[i] != KEYLESS_OWNER) revert HostOwnerNotKeyless(owners[i]);
            }
            return HOST_SAFE;
        }
        (ok, ret) = account.staticcall(abi.encodeCall(IHostProbe.accountId, ()));
        if (ok && ret.length >= 64) {
            bytes memory id = bytes(abi.decode(ret, (string)));
            if (_hasPrefix(id, "kernel.")) return HOST_KERNEL;
        }
        return HOST_GENERIC;
    }

    function _hasPrefix(bytes memory s, bytes memory prefix) internal pure returns (bool) {
        if (s.length < prefix.length) return false;
        for (uint256 i; i < prefix.length; ++i) {
            if (s[i] != prefix[i]) return false;
        }
        return true;
    }

    function _checkBounds(uint256 perTxMaxUsd, uint256 maxFeeWei, uint256 maxPrio) internal pure {
        if (perTxMaxUsd > type(uint96).max || maxFeeWei > type(uint128).max || maxPrio > type(uint128).max) {
            revert BadConfig();
        }
    }

    function _authLoosen(address account, bool loosening) internal view {
        if (loosening && !ILeakedRoleContext(EXECUTOR).isQueuedContext(account)) revert MustQueue();
    }

    function _initialized(address account) internal view returns (Policy storage p) {
        p = _policies[account];
        if (!p.initialized) revert NotInitialized(account);
    }

    function _tkey(bytes32 tag, address account) private pure returns (bytes32 k) {
        assembly ("memory-safe") {
            mstore(0x00, tag)
            mstore(0x20, account)
            k := keccak256(0x00, 0x40)
        }
    }

    function _tload(bytes32 tag, address account) private view returns (uint256 v) {
        bytes32 k = _tkey(tag, account);
        assembly ("memory-safe") {
            v := tload(k)
        }
    }

    function _tstore(bytes32 tag, address account, uint256 v) private {
        bytes32 k = _tkey(tag, account);
        assembly ("memory-safe") {
            tstore(k, v)
        }
    }
}
