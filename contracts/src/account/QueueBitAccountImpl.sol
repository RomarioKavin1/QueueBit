// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RollingCap} from "../lib/RollingCap.sol";
import {TypedPermits} from "../lib/TypedPermits.sol";
import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {IRoleSignerFactory} from "../interfaces/IRoleSignerFactory.sol";
import {QueueBitVerify} from "./QueueBitVerify.sol";
import {QueueBitAccountStorage} from "./QueueBitAccountStorage.sol";
import {QueueBitAccountBase} from "./QueueBitAccountBase.sol";

/// @title QueueBitAccountImpl
/// @notice The QueueBit frame-native smart account (UUPS implementation behind an ERC1967 proxy). A capped hot key that
///         is safe to leak, a post-quantum vault and recovery reached only through their own signer contracts
///         (authorised here by `msg.sender`), a guardian that can only pause.
///         Spec: `docs/plan/sections/10-contracts.md` §10.3.2-§10.3.5, §10.5.1, §10.7.
///
///         Tiers:
///         - hot: `verifyFrame()` (VERIFY, `QueueBitVerify`) then `hotExecute` (SENDER frame, msg.sender == this):
///           allowlisted ERC-20 `transfer`s and ETH sends (to any recipient in `RecipientMode.Open`, the default;
///           to allowlisted recipients in `Strict`), vault-issued session calls with
///           balance-delta accounting, `registerHash` for value-bearing 1271 hashes; all debited at vault-set static
///           prices from one rolling USD bucket (`RollingCap`), bounded per tx and stopped by freeze or bunker;
///         - vault: tightening is instant; loosening, large spends, upgrade and migration are queued (default 48 h)
///           and executable by anyone after the delay; small spends draw on a daily instant allowance;
///         - recovery: cancels any queued vault op and starts a 7-day vault rotation the vault cannot cancel;
///         - guardian: `guardianFreeze()`, once per 7 days each, 72 h, cleared by anyone after expiry.
contract QueueBitAccountImpl is QueueBitVerify, QueueBitAccountBase, Initializable, UUPSUpgradeable, ERC7739 {
    using RollingCap for RollingCap.Bucket;

    // ------------------------------------------------------------------------------------------- constants ------

    /// ERC-1271 marker for a registered hash: `REGISTERED_MARKER ‖ hash` (36 bytes). Some dapp SDKs refuse an empty
    /// signature; they may pass this instead. Both are accepted for a live registered hash and nothing else.
    bytes4 public constant REGISTERED_MARKER = 0x427a9529; // bytes4(keccak256("queuebit.account.registeredHash"))

    /// Permit2 (same address on every chain): a hot-key 7739 signature is never valid when Permit2 asks.
    address internal constant PERMIT2 = TypedPermits.PERMIT2;

    bytes4 private constant MAGIC_1271 = 0x1626ba7e;
    uint8 private constant ROLE_VAULT = 1; // PQRoleSigner.ROLE_VAULT
    uint8 private constant ROLE_RECOVERY = 2; // PQRoleSigner.ROLE_RECOVERY
    bytes4 private constant ERC20_APPROVE = 0x095ea7b3;
    bytes4 private constant ERC20_INCREASE_ALLOWANCE = 0x39509351;
    bytes4 private constant SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes32 private constant SENTINEL_7739 = 0x7739773977397739773977397739773977397739773977397739773977397739;

    /// The role surface (`QueueBitAccountRoles`), reached by DELEGATECALL from `fallback()`.
    address public immutable ROLES_MODULE;

    // -------------------------------------------------------------------------------------------- setup ------

    /// @param devnet       which opcode helpers to deploy (HegotaSupport); pins the frame-opcode encoding.
    /// @param perGasMaxFee TXPARAM(MAX_FEE) semantics of the target chain (see `QueueBitVerify.PER_GAS_MAX_FEE`).
    /// @param rolesModule  the `QueueBitAccountRoles` deployment this implementation delegates role calls to.
    constructor(Devnet devnet, bool perGasMaxFee, address rolesModule)
        QueueBitVerify(devnet, perGasMaxFee)
        EIP712("QueueBit", "1")
    {
        if (rolesModule.code.length == 0) revert BadAddress(rolesModule);
        ROLES_MODULE = rolesModule;
        _disableInitializers();
    }

    /// @notice One-time setup of a fresh proxy (the factory passes this as the proxy's init data).
    /// @dev Bound mode (`c.vault.pk != 0`, the default path): the vault signer is not an input but derived from the
    ///      vault's PQ parameters and this proxy's own address, `c.roleSignerFactory.predictRoleSigner(c.vault.salt,
    ///      1, address(this), c.vault.pk, c.vault.verifier, c.vault.payerKey)`; likewise the recovery signer (role 2)
    ///      when `c.recovery.pk != 0`. The proxy's CREATE2 address commits to those parameters (they are init data),
    ///      the clone's to this address: both are counterfactual, and the clone may be deployed later by anyone
    ///      (`createRoleSigner` with the same arguments; `RoleSignerDerived` logs them). Explicit mode (pk == 0):
    ///      the address in `c.vaultSigner` / `c.recoverySigner` (an unbound `PQRoleSigner`, a test signer).
    function initialize(InitConfig calldata c) external initializer {
        QueueBitAccountStorage.Layout storage $ = _s();
        if (c.hotKey == address(0) || c.hotKey == address(this)) revert BadAddress(c.hotKey);
        address vaultSigner = _roleSigner(c.roleSignerFactory, c.vault, c.vaultSigner, ROLE_VAULT);
        address recoverySigner = _roleSigner(c.roleSignerFactory, c.recovery, c.recoverySigner, ROLE_RECOVERY);
        // Role independence: distinct signers (from each other, the account and the everyday key; the tank below)
        // holding distinct PQ keys.
        if (vaultSigner == address(0) || vaultSigner == address(this) || vaultSigner == c.hotKey) {
            revert BadAddress(vaultSigner);
        }
        if (
            recoverySigner != address(0)
                && (recoverySigner == address(this) || recoverySigner == vaultSigner || recoverySigner == c.hotKey)
        ) {
            revert BadAddress(recoverySigner);
        }
        if (recoverySigner != address(0)) _checkIndependentKeys(c.vault.pk, vaultSigner, c.recovery.pk, recoverySigner);
        // Path B payer keys live on the role's own device: never the everyday key or the tank (both on the hot
        // device, assumed leakable: a payer key alone can burn its signer's ETH with PQ-invalid transactions), and
        // the vault's and the recovery's are distinct keys.
        _checkPayerKey(c.vault.payerKey, c.hotKey, c.tank);
        _checkPayerKey(c.recovery.payerKey, c.hotKey, c.tank);
        if (c.vault.payerKey != address(0) && c.vault.payerKey == c.recovery.payerKey) {
            revert BadAddress(c.recovery.payerKey);
        }
        uint8 frames = c.maxHotFrames == 0 ? DEFAULT_MAX_HOT_FRAMES : c.maxHotFrames;
        uint48 delay = c.timelockDelay == 0 ? DEFAULT_TIMELOCK : c.timelockDelay;
        _checkCapBounds(c.perTxMaxUsd, c.maxFeeWeiPerTx, frames);
        if (c.maxPriorityFeePerGas > type(uint128).max || delay < MIN_TIMELOCK || delay > MAX_TIMELOCK) {
            revert BadConfig();
        }

        $.hotKey = c.hotKey;
        $.vaultSigner = vaultSigner;
        $.recoverySigner = recoverySigner;
        $.maxHotFrames = frames;
        $.perTxMaxUsd = uint96(c.perTxMaxUsd);
        $.maxFeeWeiPerTx = uint128(c.maxFeeWeiPerTx);
        $.hotBucket.init(c.capUsdPerDay);
        $.timelockDelay = delay;
        $.vaultBucket.init(c.timelockThresholdUsd);
        emit HotKeyRotated(address(0), c.hotKey);
        emit VaultSignerSet(vaultSigner);
        if (recoverySigner != address(0)) emit RecoverySignerSet(recoverySigner);
        emit CapUpdated(c.capUsdPerDay, c.perTxMaxUsd, c.maxFeeWeiPerTx, frames);
        emit TimelockUpdated(delay, c.timelockThresholdUsd);
        _setFeePolicy($, c.maxPriorityFeePerGas, c.selfPay, c.tank);

        // UX decision (ux-spec §9 item 4): the fee tank is an everyday recipient, so a low tank never needs the vault.
        if (c.tank != address(0)) {
            if (c.tank == address(this) || c.tank == vaultSigner || c.tank == recoverySigner) {
                revert BadAddress(c.tank);
            }
            $.targets[c.tank] = true;
            emit TargetConfigured(c.tank, true);
        }
        if (c.ethUsdPrice != 0) {
            $.tokens[address(0)] = TokenCfg(true, 18, c.ethUsdPrice);
            emit TokenConfigured(address(0), true, 18, c.ethUsdPrice);
        }
        _initTokens($, c, vaultSigner, recoverySigner);
        $.valueVerifiers[PERMIT2] = true;
        emit ValueVerifierSet(PERMIT2, true);
        $.recipientsOpen = c.recipientMode == RecipientMode.Open;
        emit RecipientModeSet(c.recipientMode);
    }

    /// The initial ERC-20 allowlist (`InitConfig.tokens`): what `vaultSetToken(token, true, decimals, usdPerToken)`
    /// stores and emits, with the setter's price bounds, plus: at most `MAX_TOKENS`, no duplicates, and each token a
    /// contract that is not the account, a role signer, the hot key or the tank. Execution-only slots (I-2).
    function _initTokens(
        QueueBitAccountStorage.Layout storage $,
        InitConfig calldata c,
        address vaultSigner,
        address recoverySigner
    ) private {
        uint256 n = c.tokens.length;
        if (n > MAX_TOKENS) revert TooManyTokens();
        for (uint256 i; i < n; ++i) {
            TokenInit calldata t = c.tokens[i];
            address token = t.token;
            if (
                token == address(0) || token == address(this) || token == vaultSigner || token == recoverySigner
                    || token == c.hotKey || token == c.tank || token.code.length == 0
            ) revert BadAddress(token);
            if (t.usdPerToken == 0 || t.decimals > 36) revert BadConfig();
            if ($.tokens[token].allowed) revert DuplicateToken(token);
            $.tokens[token] = TokenCfg(true, t.decimals, t.usdPerToken);
            $.tokenList.push(token);
            emit TokenConfigured(token, true, t.decimals, t.usdPerToken);
        }
    }

    /// A bound role's Path B payer key (0 = Path B off): never the hot key or the tank.
    function _checkPayerKey(address payer, address hotKey, address tank) private pure {
        if (payer != address(0) && (payer == hotKey || payer == tank)) revert BadAddress(payer);
    }

    /// The role signer of `role`: derived from `p` (bound mode) or the explicit address (`p` all zero).
    function _roleSigner(address factory, RoleSignerParams calldata p, address explicit, uint8 role)
        private
        returns (address signer)
    {
        if (p.pk == bytes32(0)) {
            if (p.salt != bytes32(0) || p.verifier != address(0) || p.payerKey != address(0)) revert BadConfig();
            return explicit;
        }
        // Bound: the address must come from the parameters alone, and must be one `createRoleSigner` can deploy
        // (the factory refuses a verifier without a fixed `sigLength`; such an address would never get code).
        if (explicit != address(0) || factory.code.length == 0 || _sigLength(p.verifier) == 0) revert BadConfig();
        signer =
            IRoleSignerFactory(factory).predictRoleSigner(p.salt, role, address(this), p.pk, p.verifier, p.payerKey);
        emit RoleSignerDerived(role, signer, factory, p.salt, p.pk, p.verifier, p.payerKey);
    }

    /// `verifier.sigLength()` with the factory's acceptance rule (code, answers, 1..65535), else 0.
    function _sigLength(address verifier) private view returns (uint256 len) {
        if (verifier.code.length == 0) return 0;
        (bool ok, bytes memory ret) = verifier.staticcall(abi.encodeCall(IPQVerifier.sigLength, ()));
        if (ok && ret.length >= 32) len = abi.decode(ret, (uint256));
        if (len > type(uint16).max) len = 0;
    }

    /// Accepts ETH. (An empty-data VERIFY frame lands here and never approves: `verifyFrame()` is the entry.)
    receive() external payable {}

    /// Role entry points (`vault*`, `recovery*`, `guardianFreeze`, `execute*`, role views) live in
    /// `QueueBitAccountRoles`; every other selector reverts there. The module holds no APPROVE helper, so nothing it
    /// runs can approve a frame.
    fallback() external payable {
        address m = ROLES_MODULE;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), m, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }

    // -------------------------------------------------------------------------------------- hot execution ------

    /// @notice The hot tier's only execution entry; reachable as the SENDER frame after `verifyFrame()` approved.
    /// @param declaredUsd the batch's USD value as the extension computed it (6 decimals). VERIFY bounds it by
    ///        `perTxMaxUsd`; here the actual debit (static debits, session balance deltas, registered hashes, and
    ///        the batch's total balance delta, whichever is larger) must not exceed it.
    function hotExecute(uint256 declaredUsd, Call[] calldata calls) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _noActiveContext();
        QueueBitAccountStorage.Layout storage $ = _s();
        if ($.bunker) revert BunkerActive();
        if ($.hotFrozen) revert HotFrozen();
        uint256 n = calls.length;
        if (n == 0 || n > MAX_HOT_CALLS) revert BadCallCount(n);

        _tstore(T_HOT, 1);
        uint256[] memory start = _snapshot($);
        uint256 debit;
        for (uint256 i; i < n; ++i) {
            debit += _hotCall($, calls[i], i);
        }
        debit += _tload(T_HOT_DEBIT);
        uint256 batchOut = _outflowUsd($, start, true);
        if (batchOut > debit) debit = batchOut;

        if (debit > declaredUsd) revert DeclaredUsdExceeded(debit, declaredUsd);
        if (debit > $.perTxMaxUsd) revert PerTxMaxExceeded(debit, $.perTxMaxUsd);
        $.hotBucket.spend(debit);
        _checkNoStandingApprovals(calls); // I-6
        _tstore(T_HOT, 0);
        _tstore(T_HOT_DEBIT, 0);
        emit HotExecuted(debit, $.hotBucket.available, n);
    }

    /// @notice Registers an opaque hash for ERC-1271, debiting `amount` of `token` (address(0) = ETH) from the hot
    ///         bucket. Only as a call of a hot batch. The debit is self-declared (the contract cannot read a hash's
    ///         value), so the hash is honoured only under the hot verifier rule of `isValidSignature`: never for a
    ///         token, Permit2 or any on-chain verifier the vault has not trusted. Token permits: `registerPermit`.
    function registerHash(bytes32 hash, address token, uint256 amount, uint48 expiry) external {
        if (msg.sender != address(this)) revert OnlySelf();
        if (_tload(T_HOT) == 0) revert NotInHotBatch();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_REGISTERED_TTL) revert BadExpiry();
        uint256 usd = quoteUsd(token, amount);
        QueueBitAccountStorage.Layout storage $ = _s();
        $.registeredHashes[hash] = expiry;
        delete $.registeredFor[hash];
        _tstore(T_HOT_DEBIT, _tload(T_HOT_DEBIT) + usd);
        emit HashRegistered(hash, token, amount, expiry);
    }

    /// @notice Registers an ERC-2612 permit of `value` base units of the allowlisted `token` to `spender`: the digest
    ///         is computed here from the token's `DOMAIN_SEPARATOR()` and `nonces(this)`, so the hot bucket is
    ///         debited by the permit's own value, and only `token` may consume the hash (its `permit`, for tokens
    ///         that check EIP-1271). Expires at `deadline`, at most `MAX_REGISTERED_TTL` from now. Hot batch only.
    function registerPermit(address token, address spender, uint256 value, uint256 deadline) external {
        TokenCfg storage t = _typedToken(token);
        bytes32 digest = TypedPermits.erc2612Digest(token, address(this), spender, value, deadline);
        _registerBound(t, digest, token, value, deadline, token);
    }

    /// @notice Registers a Permit2 `PermitSingle` (AllowanceTransfer) of `amount` of the allowlisted `token` to
    ///         `spender`, valid until `expiration`, signature deadline `sigDeadline`. The digest is computed here
    ///         (Permit2's domain and type hashes, the current `allowance(this, token, spender).nonce`), the hot
    ///         bucket is debited by `amount` (once: what the spender later pulls through Permit2 is already paid
    ///         for), and only Permit2 may consume the hash. `spender` must be an allowlisted target or hold a live
    ///         session `(spender, sessionSelector)`. `expiration` is in (now, now + MAX_REGISTERED_TTL] (0, "this
    ///         block", is refused). Needs the vault to have approved Permit2 on `token`. Hot batch only.
    function registerPermit2(
        address token,
        uint160 amount,
        uint48 expiration,
        address spender,
        uint256 sigDeadline,
        bytes4 sessionSelector
    ) external {
        TokenCfg storage t = _typedToken(token);
        _checkSpender(spender, sessionSelector);
        if (expiration <= block.timestamp || expiration > block.timestamp + MAX_REGISTERED_TTL) revert BadExpiry();
        bytes32 digest = TypedPermits.permitSingleDigest(address(this), token, amount, expiration, spender, sigDeadline);
        _registerBound(t, digest, token, amount, sigDeadline, TypedPermits.PERMIT2);
    }

    /// @notice Registers a Permit2 `PermitTransferFrom` (SignatureTransfer) of up to `amount` of the allowlisted
    ///         `token`, to be called by `spender` (Permit2 hashes its caller as the spender), unordered `nonce`
    ///         (must be unspent), until `deadline`. Debits `amount`; only Permit2 may consume the hash; `spender` as
    ///         in `registerPermit2`. Witness transfers (`permitWitnessTransferFrom`) are not supported. Hot batch only.
    function registerPermit2Transfer(
        address token,
        uint256 amount,
        address spender,
        uint256 nonce,
        uint256 deadline,
        bytes4 sessionSelector
    ) external {
        TokenCfg storage t = _typedToken(token);
        _checkSpender(spender, sessionSelector);
        if (TypedPermits.permit2NonceUsed(address(this), nonce)) revert NonceUsed();
        bytes32 digest = TypedPermits.permitTransferFromDigest(token, amount, spender, nonce, deadline);
        _registerBound(t, digest, token, amount, deadline, TypedPermits.PERMIT2);
    }

    /// @notice Registers an EIP-3009 `TransferWithAuthorization` (or, `receiveAuth`, `ReceiveWithAuthorization`)
    ///         of `value` of the allowlisted `token` to `to`, valid in (`validAfter`, `validBefore`), unspent `nonce`.
    ///         `to` follows the hot `transfer` recipient rule (`_checkRecipient`: any non-forbidden recipient in Open,
    ///         an allowlisted one in Strict): the authorization can move no more, and to nobody else, than a hot
    ///         `transfer` could. Debits `value`; only `token` may consume the hash. Hot batch only.
    function registerTransferAuthorization(
        address token,
        uint256 value,
        address to,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bool receiveAuth
    ) external {
        TokenCfg storage t = _typedToken(token);
        _checkRecipient(_s(), to, token, IERC20.transfer.selector);
        if (validAfter >= validBefore) revert BadExpiry();
        if (TypedPermits.authorizationUsed(token, address(this), nonce)) revert NonceUsed();
        bytes32 digest = TypedPermits.authorizationDigest(
            token, receiveAuth, address(this), to, value, validAfter, validBefore, nonce
        );
        _registerBound(t, digest, token, value, validBefore, token);
    }

    /// @notice Clears an expired freeze. Permissionless; also the one SENDER call VERIFY admits while frozen.
    function clearExpiredFreeze() external {
        QueueBitAccountStorage.Layout storage $ = _s();
        if (!$.hotFrozen) revert NotFrozen();
        if ($.pendingVaultEta != 0) revert RotationPending();
        if (block.timestamp < $.frozenUntil) revert FreezeNotExpired($.frozenUntil);
        $.hotFrozen = false;
        $.frozenUntil = 0;
        emit Unfrozen(msg.sender);
    }

    // --------------------------------------------------------------------------------------------- 1271 ------

    /// @notice Scoped ERC-1271. The account cannot tell zero-value typed data from a permit or an order, so what the
    ///         hot key may sign is bounded by who asks (`msg.sender`), the "hot verifier rule":
    ///         a code-less caller (eth_call verification: SIWE and other off-chain checks) or a vault-trusted
    ///         on-chain verifier (`vaultSetTrustedVerifier`), and never an allowlisted token or a denied value
    ///         verifier (Permit2 by default). Under that rule:
    ///         1. a hash registered by a hot batch (`registerHash`), unexpired: valid with an empty signature or the
    ///            36-byte marker `REGISTERED_MARKER ‖ hash`; a `registerPermit` hash is instead valid for its token
    ///            alone (the one caller whose value the account did bind and debit);
    ///         2. ERC-7739 nested typed data / personal sign by the hot key, for any app domain.
    ///         3. The 7739 support sentinel, for anyone. Vault or recovery material is never accepted here.
    ///         Nothing else is accepted while the hot tier is frozen or bunkered. A view: nothing is logged.
    function isValidSignature(bytes32 hash, bytes calldata signature) public view override returns (bytes4) {
        if (hash == SENTINEL_7739 && signature.length == 0) return super.isValidSignature(hash, signature);
        QueueBitAccountStorage.Layout storage $ = _s();
        if ($.bunker || $.hotFrozen || $.hotKey == address(0)) return bytes4(0xffffffff);
        bool callerOk = _hotVerifierAllowed($, msg.sender);
        uint48 exp = $.registeredHashes[hash];
        if (exp != 0 && block.timestamp <= exp && _isRegisteredMarker(hash, signature)) {
            address only = $.registeredFor[hash];
            if (only == address(0) ? callerOk : msg.sender == only) return MAGIC_1271;
        }
        if (!callerOk) return bytes4(0xffffffff);
        return super.isValidSignature(hash, signature);
    }

    /// The hot verifier rule (see `isValidSignature`).
    function _hotVerifierAllowed(QueueBitAccountStorage.Layout storage $, address caller) private view returns (bool) {
        if ($.valueVerifiers[caller] || (caller != address(0) && $.tokens[caller].allowed)) return false;
        return caller.code.length == 0 || $.trustedVerifiers[caller];
    }

    /// The hot key's raw ECDSA check for the ERC-7739 envelope (65-byte or 64-byte compact signatures).
    function _rawSignatureValidation(bytes32 hash, bytes calldata signature) internal view override returns (bool) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecoverCalldata(hash, signature);
        return err == ECDSA.RecoverError.NoError && signer == _s().hotKey;
    }

    // ------------------------------------------------------------------------------------------- views ------

    function accountId() external pure returns (string memory) {
        return "queuebit.account.1.0.0";
    }

    function getHotConfig() external view returns (HotConfig memory c) {
        QueueBitAccountStorage.Layout storage $ = _s();
        c = HotConfig(
            $.hotKey,
            $.hotFrozen,
            $.bunker,
            $.selfPay,
            $.maxHotFrames,
            $.tank,
            $.perTxMaxUsd,
            $.maxFeeWeiPerTx,
            $.maxPriorityFeePerGas,
            $.frozenUntil
        );
    }

    /// @notice The hot bucket. `available` is what can be spent now; `fullAt` is when the bucket is full again (the
    ///         refill is continuous, so this is the "frees up at" of the limit meter: the moment everything spent in
    ///         the last 24 h has refilled; `now` when already full).
    function getBucket() external view returns (uint256 available, uint48 lastUpdate, uint256 cap, uint48 fullAt) {
        RollingCap.Bucket storage b = _s().hotBucket;
        available = b.availableNow();
        lastUpdate = b.lastUpdate;
        cap = b.cap;
        fullAt = uint48(block.timestamp);
        if (available < cap) fullAt += uint48(Math.mulDiv(cap - available, 1 days, cap, Math.Rounding.Ceil));
    }

    /// @notice USD value (6 decimals, rounded up) of `amount` base units of `token` (address(0) = ETH).
    function quoteUsd(address token, uint256 amount) public view returns (uint256) {
        TokenCfg storage t = _s().tokens[token];
        if (!t.allowed) revert TokenNotAllowed(token);
        return _quote(t, amount);
    }

    function getToken(address token) external view returns (TokenCfg memory) {
        return _s().tokens[token];
    }

    function isTarget(address target) external view returns (bool) {
        return _s().targets[target];
    }

    /// @notice Who may receive a hot ETH send or token `transfer` (Open: anyone; Strict: `isTarget` only).
    function recipientMode() external view returns (RecipientMode) {
        return _s().recipientsOpen ? RecipientMode.Open : RecipientMode.Strict;
    }

    function getSession(address target, bytes4 selector) external view returns (Session memory) {
        return _s().sessions[sessionId(target, selector)];
    }

    function registeredHashExpiry(bytes32 hash) external view returns (uint48) {
        return _s().registeredHashes[hash];
    }

    /// @notice The one contract that may consume a registered hash (`registerPermit`: the token); address(0) for a
    ///         hash registered with `registerHash` (the hot verifier rule applies).
    function registeredHashConsumer(bytes32 hash) external view returns (address) {
        return _s().registeredFor[hash];
    }

    function sessionId(address target, bytes4 selector) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(target, selector));
    }

    // ---------------------------------------------------------------------------------------- internals ------

    /// One hot call; returns its static USD debit (session calls: their measured outflow).
    function _hotCall(QueueBitAccountStorage.Layout storage $, Call calldata c, uint256 i) private returns (uint256) {
        address t = c.target;
        bytes4 sel = _selector(c.data);
        if (t == address(this)) {
            // Only the self-calls a hot batch may make (the register* calls debit through T_HOT_DEBIT).
            if (
                c.value != 0
                    || (
                        sel != this.registerHash.selector && sel != this.registerPermit.selector
                            && sel != this.registerPermit2.selector && sel != this.registerPermit2Transfer.selector
                            && sel != this.registerTransferAuthorization.selector && sel != this.clearExpiredFreeze.selector
                    )
            ) {
                revert NotAllowed(t, sel);
            }
            _call(i, t, 0, c.data);
            return 0;
        }
        if (c.data.length == 0) {
            // Plain ETH: to an allowlisted recipient, or (Open) to any recipient, with value. A zero-value empty call
            // moves nothing and only runs the target's fallback: it is a non-transfer call and needs the allowlist.
            if (c.value == 0 && !$.targets[t]) revert NotAllowed(t, bytes4(0));
            _checkRecipient($, t, address(0), bytes4(0));
            uint256 usd = quoteUsd(address(0), c.value);
            _call(i, t, c.value, "");
            return usd;
        }
        TokenCfg storage tc = $.tokens[t];
        if (t != address(0) && tc.allowed && sel == IERC20.transfer.selector) {
            // ERC-20 transfer of an allowlisted (priced) token to an allowlisted recipient, or (Open) to any
            // recipient (H2: nothing else on a token: no approve / permit / transferFrom outside a session).
            if (c.value != 0 || c.data.length != 68) revert NotAllowed(t, sel);
            (address to, uint256 amount) = abi.decode(c.data[4:], (address, uint256));
            _checkRecipient($, to, t, sel);
            uint256 usd = _quote(tc, amount);
            _callToken(i, t, c.data);
            return usd;
        }
        // Session call: vault-issued (target, selector) policy, debited by measured balance delta (H4).
        bytes32 sid = sessionId(t, sel);
        Session storage s = $.sessions[sid];
        if (s.expiry == 0 || block.timestamp > s.expiry) revert NotAllowed(t, sel);
        // An approval is only accountable on an asset the balance-delta accounting watches: a session on an asset
        // that is not (or no longer) an allowlisted token would let a router pull it with a zero debit.
        if ((sel == ERC20_APPROVE || sel == ERC20_INCREASE_ALLOWANCE || sel == SET_APPROVAL_FOR_ALL) && !tc.allowed) {
            revert NotAllowed(t, sel);
        }
        uint256[] memory before = _snapshot($);
        _call(i, t, c.value, c.data);
        uint256 used = _outflowUsd($, before, true);
        uint256 left = s.allowanceUsd;
        if (used > left) revert SessionAllowanceExceeded(sid, used, left);
        unchecked {
            left -= used;
        }
        s.allowanceUsd = left;
        emit SessionUsed(sid, used, left);
        return used;
    }

    /// Who may receive a hot ETH send (`token == address(0)`) or a `transfer` of `token`; reverts otherwise.
    /// - never address(0) (a burn is never an everyday payment): `NotAllowed`;
    /// - never self-defeating, in either mode (mirrors H2, `_checkPolicyTarget`, for a recipient the vault may have
    ///   allowlisted before a role change): the account itself, the vault or recovery signer, or the token being
    ///   moved (`to == token`): `ForbiddenRecipient`. (A pending rotation's signer is not checked: the rotation
    ///   freezes the hot tier until it finalizes, and neither `vaultUnfreeze` nor `clearExpiredFreeze` lifts it.)
    /// - an allowlisted recipient is admitted (this is the tank's top-up path: `initialize` allowlists the tank);
    /// - otherwise Strict: `NotAllowed`; Open: anyone but the tank, a guardian or an allowlisted token contract
    ///   (`ForbiddenRecipient`): fees, a freeze-only role and a token's own balance are never paid by the hot key
    ///   without the vault allowlisting them.
    function _checkRecipient(QueueBitAccountStorage.Layout storage $, address to, address token, bytes4 sel)
        private
        view
    {
        if (to == address(0)) revert NotAllowed(to, sel);
        if (to == address(this) || to == token || to == $.vaultSigner || to == $.recoverySigner) {
            revert ForbiddenRecipient(to);
        }
        if ($.targets[to]) return;
        if (!$.recipientsOpen) revert NotAllowed(to, sel);
        if (to == $.tank || $.guardians[to].enabled || $.tokens[to].allowed) revert ForbiddenRecipient(to);
    }

    /// I-6: no approval granted inside the batch survives it.
    function _checkNoStandingApprovals(Call[] calldata calls) private view {
        for (uint256 i; i < calls.length; ++i) {
            bytes calldata d = calls[i].data;
            bytes4 sel = _selector(d);
            if (d.length < 36) continue;
            address spender = address(uint160(uint256(bytes32(d[4:36]))));
            address t = calls[i].target;
            if (sel == ERC20_APPROVE || sel == ERC20_INCREASE_ALLOWANCE) {
                (bool ok, bytes memory ret) = t.staticcall(abi.encodeCall(IERC20.allowance, (address(this), spender)));
                if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 0) revert StandingApproval(t, spender);
            } else if (sel == SET_APPROVAL_FOR_ALL) {
                (bool ok, bytes memory ret) = t.staticcall(abi.encodeWithSelector(0xe985e9c5, address(this), spender)); // isApprovedForAll
                if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 0) revert StandingApproval(t, spender);
            }
        }
    }

    /// A typed registration's caller and token: a self-call of the open hot batch, an allowlisted (priced) ERC-20.
    function _typedToken(address token) private view returns (TokenCfg storage t) {
        if (msg.sender != address(this)) revert OnlySelf();
        if (_tload(T_HOT) == 0) revert NotInHotBatch();
        t = _s().tokens[token];
        if (token == address(0) || !t.allowed) revert TokenNotAllowed(token);
    }

    /// A Permit2 spender: an allowlisted target, or the target of a live session `(spender, selector)`. Never the
    /// Open-mode "anyone": the spender decides where the tokens go.
    function _checkSpender(address spender, bytes4 selector) private view {
        QueueBitAccountStorage.Layout storage $ = _s();
        if ($.targets[spender]) return;
        Session storage s = $.sessions[sessionId(spender, selector)];
        if (s.expiry < block.timestamp || s.allowanceUsd == 0) revert NotAllowed(spender, selector);
    }

    /// Registers `digest` for `consumer` alone until min(deadline, now + MAX_REGISTERED_TTL) and debits `amount`.
    function _registerBound(
        TokenCfg storage t,
        bytes32 digest,
        address token,
        uint256 amount,
        uint256 deadline,
        address consumer
    ) private {
        if (deadline <= block.timestamp) revert BadExpiry();
        uint48 expiry = uint48(Math.min(deadline, block.timestamp + MAX_REGISTERED_TTL));
        QueueBitAccountStorage.Layout storage $ = _s();
        $.registeredHashes[digest] = expiry;
        $.registeredFor[digest] = consumer;
        _tstore(T_HOT_DEBIT, _tload(T_HOT_DEBIT) + _quote(t, amount));
        emit HashRegistered(digest, token, amount, expiry);
    }

    function _isRegisteredMarker(bytes32 hash, bytes calldata signature) private pure returns (bool) {
        if (signature.length == 0) return true;
        return signature.length == 36 && bytes4(signature[0:4]) == REGISTERED_MARKER && bytes32(signature[4:36]) == hash;
    }

    /// ERC-20 call with SafeERC20 semantics: success and (no return data from a contract, or `true`).
    function _callToken(uint256 i, address token, bytes calldata data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) revert CallFailed(i, ret);
        if (ret.length == 0 ? token.code.length == 0 : (ret.length < 32 || abi.decode(ret, (uint256)) != 1)) {
            revert TransferFailed(token);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal view override {
        if (msg.sender != address(this) || address(uint160(_tload(T_UPGRADE))) != newImplementation) {
            revert UpgradeNotAuthorized();
        }
    }
}
