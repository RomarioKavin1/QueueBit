// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ERC7739} from "@openzeppelin/contracts/utils/cryptography/signers/draft-ERC7739.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {RollingCap} from "../lib/RollingCap.sol";
import {LeakedVerify} from "./LeakedVerify.sol";
import {LeakedAccountStorage} from "./LeakedAccountStorage.sol";
import {LeakedAccountBase} from "./LeakedAccountBase.sol";

/// @title LeakedAccountImpl
/// @notice The LEAKED frame-native smart account (UUPS implementation behind an ERC1967 proxy). A capped hot key that
///         is safe to leak, a post-quantum vault and recovery reached only through their own signer contracts
///         (authorised here by `msg.sender`), a guardian that can only pause.
///         Spec: `docs/plan/sections/10-contracts.md` §10.3.2-§10.3.5, §10.5.1, §10.7.
///
///         Tiers:
///         - hot: `verifyFrame()` (VERIFY, `LeakedVerify`) then `hotExecute` (SENDER frame, msg.sender == this):
///           allowlisted ERC-20 `transfer`s and ETH sends to allowlisted recipients, vault-issued session calls with
///           balance-delta accounting, `registerHash` for value-bearing 1271 hashes; all debited at vault-set static
///           prices from one rolling USD bucket (`RollingCap`), bounded per tx and stopped by freeze or bunker;
///         - vault: tightening is instant; loosening, large spends, upgrade and migration are queued (default 48 h)
///           and executable by anyone after the delay; small spends draw on a daily instant allowance;
///         - recovery: cancels any queued vault op and starts a 7-day vault rotation the vault cannot cancel;
///         - guardian: `guardianFreeze()`, once per 7 days each, 72 h, cleared by anyone after expiry.
contract LeakedAccountImpl is LeakedVerify, LeakedAccountBase, Initializable, UUPSUpgradeable, ERC7739 {
    using RollingCap for RollingCap.Bucket;

    // ------------------------------------------------------------------------------------------- constants ------

    /// ERC-1271 marker for a registered hash: `REGISTERED_MARKER ‖ hash` (36 bytes). Some dapp SDKs refuse an empty
    /// signature; they may pass this instead. Both are accepted for a live registered hash and nothing else.
    bytes4 public constant REGISTERED_MARKER = 0xdc6b87c9; // bytes4(keccak256("leaked.account.registeredHash"))

    /// Permit2 (same address on every chain): a hot-key 7739 signature is never valid when Permit2 asks.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    bytes4 private constant MAGIC_1271 = 0x1626ba7e;
    bytes4 private constant ERC20_APPROVE = 0x095ea7b3;
    bytes4 private constant ERC20_INCREASE_ALLOWANCE = 0x39509351;
    bytes4 private constant SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes32 private constant SENTINEL_7739 = 0x7739773977397739773977397739773977397739773977397739773977397739;
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// The role surface (`LeakedAccountRoles`), reached by DELEGATECALL from `fallback()`.
    address public immutable ROLES_MODULE;

    // -------------------------------------------------------------------------------------------- setup ------

    /// @param devnet       which opcode helpers to deploy (HegotaSupport); pins the frame-opcode encoding.
    /// @param perGasMaxFee TXPARAM(MAX_FEE) semantics of the target chain (see `LeakedVerify.PER_GAS_MAX_FEE`).
    /// @param rolesModule  the `LeakedAccountRoles` deployment this implementation delegates role calls to.
    constructor(Devnet devnet, bool perGasMaxFee, address rolesModule)
        LeakedVerify(devnet, perGasMaxFee)
        EIP712("LEAKED", "1")
    {
        if (rolesModule.code.length == 0) revert BadAddress(rolesModule);
        ROLES_MODULE = rolesModule;
        _disableInitializers();
    }

    /// @notice One-time setup of a fresh proxy (the factory passes this as the proxy's init data).
    function initialize(InitConfig calldata c) external initializer {
        LeakedAccountStorage.Layout storage $ = _s();
        if (c.hotKey == address(0) || c.hotKey == address(this)) revert BadAddress(c.hotKey);
        if (c.vaultSigner == address(0) || c.vaultSigner == address(this)) revert BadAddress(c.vaultSigner);
        if (c.recoverySigner == address(this) || (c.recoverySigner != address(0) && c.recoverySigner == c.vaultSigner))
        {
            revert BadAddress(c.recoverySigner);
        }
        uint8 frames = c.maxHotFrames == 0 ? DEFAULT_MAX_HOT_FRAMES : c.maxHotFrames;
        uint48 delay = c.timelockDelay == 0 ? DEFAULT_TIMELOCK : c.timelockDelay;
        _checkCapBounds(c.perTxMaxUsd, c.maxFeeWeiPerTx, frames);
        if (c.maxPriorityFeePerGas > type(uint128).max || delay < MIN_TIMELOCK || delay > MAX_TIMELOCK) {
            revert BadConfig();
        }

        $.hotKey = c.hotKey;
        $.vaultSigner = c.vaultSigner;
        $.recoverySigner = c.recoverySigner;
        $.maxHotFrames = frames;
        $.perTxMaxUsd = uint96(c.perTxMaxUsd);
        $.maxFeeWeiPerTx = uint128(c.maxFeeWeiPerTx);
        $.hotBucket.init(c.capUsdPerDay);
        $.timelockDelay = delay;
        $.vaultBucket.init(c.timelockThresholdUsd);
        emit HotKeyRotated(address(0), c.hotKey);
        emit VaultSignerSet(c.vaultSigner);
        if (c.recoverySigner != address(0)) emit RecoverySignerSet(c.recoverySigner);
        emit CapUpdated(c.capUsdPerDay, c.perTxMaxUsd, c.maxFeeWeiPerTx, frames);
        emit TimelockUpdated(delay, c.timelockThresholdUsd);
        _setFeePolicy($, c.maxPriorityFeePerGas, c.selfPay, c.tank);

        // UX decision (ux-spec §9 item 4): the fee tank is an everyday recipient, so a low tank never needs the vault.
        if (c.tank != address(0)) {
            if (c.tank == address(this) || c.tank == c.vaultSigner || c.tank == c.recoverySigner) {
                revert BadAddress(c.tank);
            }
            $.targets[c.tank] = true;
            emit TargetConfigured(c.tank, true);
        }
        if (c.ethUsdPrice != 0) {
            $.tokens[address(0)] = TokenCfg(true, 18, c.ethUsdPrice);
            emit TokenConfigured(address(0), true, 18, c.ethUsdPrice);
        }
        $.valueVerifiers[PERMIT2] = true;
        emit ValueVerifierSet(PERMIT2, true);
    }

    /// Accepts ETH. (An empty-data VERIFY frame lands here and never approves: `verifyFrame()` is the entry.)
    receive() external payable {}

    /// Role entry points (`vault*`, `recovery*`, `guardianFreeze`, `execute*`, role views) live in
    /// `LeakedAccountRoles`; every other selector reverts there. The module holds no APPROVE helper, so nothing it
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
        LeakedAccountStorage.Layout storage $ = _s();
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
        LeakedAccountStorage.Layout storage $ = _s();
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
        if (msg.sender != address(this)) revert OnlySelf();
        if (_tload(T_HOT) == 0) revert NotInHotBatch();
        LeakedAccountStorage.Layout storage $ = _s();
        TokenCfg storage t = $.tokens[token];
        if (token == address(0) || !t.allowed) revert TokenNotAllowed(token);
        if (deadline <= block.timestamp) revert BadExpiry();
        uint48 expiry = uint48(Math.min(deadline, block.timestamp + MAX_REGISTERED_TTL));
        bytes32 digest = MessageHashUtils.toTypedDataHash(
            IERC20Permit(token).DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    PERMIT_TYPEHASH, address(this), spender, value, IERC20Permit(token).nonces(address(this)), deadline
                )
            )
        );
        uint256 usd = _quote(t, value);
        $.registeredHashes[digest] = expiry;
        $.registeredFor[digest] = token;
        _tstore(T_HOT_DEBIT, _tload(T_HOT_DEBIT) + usd);
        emit HashRegistered(digest, token, value, expiry);
    }

    /// @notice Clears an expired freeze. Permissionless; also the one SENDER call VERIFY admits while frozen.
    function clearExpiredFreeze() external {
        LeakedAccountStorage.Layout storage $ = _s();
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
        LeakedAccountStorage.Layout storage $ = _s();
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
    function _hotVerifierAllowed(LeakedAccountStorage.Layout storage $, address caller) private view returns (bool) {
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
        return "leaked.account.1.0.0";
    }

    function getHotConfig() external view returns (HotConfig memory c) {
        LeakedAccountStorage.Layout storage $ = _s();
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
    function _hotCall(LeakedAccountStorage.Layout storage $, Call calldata c, uint256 i) private returns (uint256) {
        address t = c.target;
        bytes4 sel = _selector(c.data);
        if (t == address(this)) {
            // Only the self-calls a hot batch may make (the register* calls debit through T_HOT_DEBIT).
            if (
                c.value != 0
                    || (
                        sel != this.registerHash.selector && sel != this.registerPermit.selector
                            && sel != this.clearExpiredFreeze.selector
                    )
            ) {
                revert NotAllowed(t, sel);
            }
            _call(i, t, 0, c.data);
            return 0;
        }
        if (c.data.length == 0) {
            // Plain ETH to an allowlisted recipient.
            if (!$.targets[t]) revert NotAllowed(t, bytes4(0));
            uint256 usd = quoteUsd(address(0), c.value);
            _call(i, t, c.value, "");
            return usd;
        }
        TokenCfg storage tc = $.tokens[t];
        if (t != address(0) && tc.allowed && sel == IERC20.transfer.selector) {
            // ERC-20 transfer of an allowlisted token to an allowlisted recipient (H2: nothing else on a token).
            if (c.value != 0 || c.data.length != 68) revert NotAllowed(t, sel);
            (address to, uint256 amount) = abi.decode(c.data[4:], (address, uint256));
            if (!$.targets[to]) revert NotAllowed(to, sel);
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
