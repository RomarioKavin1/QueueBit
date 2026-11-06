// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam, FrameMode, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {IStakingRegistry} from "../interfaces/IStakingRegistry.sol";
import {IQueueBitAccountRoles} from "../interfaces/IQueueBitAccountRoles.sol";
import {FeeProfile} from "./FeeProfile.sol";

/// @title PQRoleSigner
/// @notice The only address that may call a QueueBit account's `vault*` / `recovery*` entry points: its own EIP-8141
///         sender whose authority is a post-quantum key (plan `10-contracts.md` §10.3.6, §10.5.2, §10.6). Deployed
///         instances are the `VaultSigner` (role 1) and `RecoverySigner` (role 2) of sections 20/30/40.
///
///         Deployment: this contract is the single IMPLEMENTATION behind Solady ERC-1167 clones with immutable args
///         (`RoleSignerFactory`). It owns the opcode helpers (`HegotaSupport` immutables, created once) and the
///         chain settings (`feeParam`, `stakingRegistry`); each clone carries its own
///         `account ‖ verifier ‖ pk ‖ sigLength ‖ role` (105 bytes) after the proxy code and holds `payerKey` /
///         `maxFee` (one packed slot) and `pathAEnabled` in its own storage. A clone runs this code by DELEGATECALL,
///         so `address(this)` is the clone (`tx.sender`), APPROVE (delegatecalled helper) acts on the clone, storage
///         is the clone's, and the per-instance args are read from the clone's code with EXTCODECOPY on `ADDRESS`
///         (CODECOPY would copy the implementation): no SLOAD for them. The implementation itself refuses to act.
///
///         `account == address(0)` ("unbound") lets the signer serve any account that names it as its vault (role 1:
///         `vaultSigner` or `pendingVaultSigner`) or recovery (role 2) signer in `getRoles()`, checked at execution.
///         It exists because an account's CREATE2 address commits to its vault signer (`initialize` data) while a
///         bound signer's address commits to its account: the two cannot both be counterfactual.
///
///         Transaction shapes (frames package builders `roleSignerPathBTx` / `roleSignerPathATx`):
///           Path B (public mempool): [VERIFY 0x3 (this, verifyFrame(0)), SENDER(this, executePQ(0, target, data))],
///                                    signatures [ARBITRARY PQ witness (sigLength B, msg ∅), SECP256K1 payerKey (msg ∅)].
///                                    VERIFY checks the pinned payer key; the PQ signature is checked in `executePQ`.
///           Path A (staked, alt):    [VERIFY 0x3 (this, verifyFrame(0)), SENDER(this, relay(target, data))],
///                                    signatures [ARBITRARY PQ witness]. The PQ signature is checked inside VERIFY.
///         Both signatures sign TXPARAM_SIG_HASH, which commits to every frame (so to `target` and `data`).
///
/// @dev    VERIFY-path rules (`10-contracts.md` "Devnet review amendments"): reads only the clone's own storage (one
///         slot: `payerKey`, `maxFee`) and code, calls nothing but the opcode helpers and (Path A) the stateless
///         verifier; never SIGDATACOPYs a SECP256K1 entry (halts on ethrex); never reads RESOLVED_SIGNER of an
///         ARBITRARY entry (halts); never reads STATUS / *_GAS_USED of a running frame; checks SIGNATURE_LENGTH before
///         SIGDATACOPY (a short entry would be zero-padded). `pk`, `verifier`, `sigLength` are clone args: rotating
///         the PQ key or scheme means a new clone installed through the account.
contract PQRoleSigner is HegotaSupport {
    // -------------------------------------------------------------------------------------------- constants ------

    uint8 public constant ROLE_VAULT = 1;
    uint8 public constant ROLE_RECOVERY = 2;

    uint8 public constant PATH_A = 1;
    uint8 public constant PATH_B = 2;

    uint256 private constant SCHEME_ARBITRARY = 0;
    uint256 private constant SCHEME_SECP256K1 = 1;

    /// Solady ERC-1167-with-args runtime: 0x2d bytes of proxy code, then the args.
    uint256 private constant ARGS_OFFSET = 0x2d;
    /// account (20) ‖ verifier (20) ‖ pk (32) ‖ sigLength (32) ‖ role (1).
    uint256 internal constant ARGS_LENGTH = 105;

    // ------------------------------------------------------------------------------------------- immutables ------

    /// ERC-8421 staking registry used by `stake` / `unlockStake` / `withdrawStake`.
    IStakingRegistry public immutable stakingRegistry;
    /// The TXPARAM that `maxFee` bounds: `MAX_FEE` (0x04, the EIP's total fee budget in wei) or, on the
    /// `ethrex-eip8141-tracer` devnet where 0x04 is per-gas, `MAX_COST` (0x06, ethrex's maximum cost in wei).
    /// Checked against the devnet at construction (`FeeProfile`).
    TxParam public immutable feeParam;
    /// The deployer of this implementation (the `RoleSignerFactory`): the only caller of `initialize`.
    address public immutable factory;
    address private immutable SELF;

    // ---------------------------------------------------------------------------------------------- storage ------

    /// Path B pinned ECDSA key (on the vault device); address(0) disables Path B. Slot 0, packed with `_maxFee`.
    address public payerKey;
    /// Upper bound on `txparam(feeParam)`: the signer's own ETH at risk per transaction. Slot 0.
    uint96 private _maxFee;
    /// Set by the role once staked; informational for the extension (Path A is valid whenever the PQ signature is).
    bool public pathAEnabled;

    // ----------------------------------------------------------------------------------------------- events ------

    event RoleTxExecuted(bytes32 indexed sigHash, uint8 path);
    event PayerKeySet(address payerKey);
    event PathASet(bool enabled);
    event MaxFeeSet(uint256 maxFee);
    event Staked(uint256 amount, uint32 delay);
    event StakeUnlocked();
    event StakeWithdrawn(address to);

    // ----------------------------------------------------------------------------------------------- errors ------

    error InvalidConfig();
    error NotClone();
    error NotFactory();
    error NotVerifyFrame();
    error ScopeNotSelfVerify();
    error BadSignatureCount(uint256 count);
    error BadWitnessEntry(uint256 sigIndex);
    error BadPayerEntry(uint256 sigIndex);
    error PathBDisabled();
    error BadFrameShape(uint256 frameIndex);
    error FeeTooHigh(uint256 fee, uint256 maxFee);
    error InvalidPQSignature();
    error OnlySelf();
    error TargetNotAllowed(address target, bytes4 selector);

    // ------------------------------------------------------------------------------------------ constructor ------

    /// The implementation (one per chain profile; `RoleSignerFactory` deploys it in its constructor).
    /// @param devnet_          opcode helper set (chain-specific opcode bytes; plan §20 §2.2: never hard-code 0xb5)
    /// @param feeParam_        `TxParam.MAX_FEE` or `TxParam.MAX_COST`, as `FeeProfile` requires for `devnet_`
    /// @param stakingRegistry_ ERC-8421 staking registry
    constructor(Devnet devnet_, TxParam feeParam_, IStakingRegistry stakingRegistry_) HegotaSupport(devnet_) {
        FeeProfile.check(devnet_, feeParam_);
        feeParam = feeParam_;
        stakingRegistry = stakingRegistry_;
        factory = msg.sender;
        SELF = address(this);
    }

    /// Storage half of a fresh clone's configuration; called by the factory in the transaction that creates the
    /// clone (so it cannot be front-run), and by nobody else. The clone's CREATE2 salt binds both values.
    function initialize(address payerKey_, uint256 maxFee_) external {
        _onlyClone();
        if (msg.sender != factory) revert NotFactory();
        if (maxFee_ > type(uint96).max) revert InvalidConfig();
        payerKey = payerKey_;
        _maxFee = uint96(maxFee_);
        emit PayerKeySet(payerKey_);
        emit MaxFeeSet(maxFee_);
    }

    // ------------------------------------------------------------------------------------------ clone args ------

    /// The QueueBit account this signer serves (the only external call target); address(0) = unbound (see header).
    function account() public view returns (address a) {
        (a,,,,) = _args();
    }

    /// Stateless scheme adapter.
    function verifier() public view returns (IPQVerifier v) {
        (, v,,,) = _args();
    }

    /// 32-byte PQ public key, convention per `IPQVerifier` (C13: pkSeed ‖ pkRoot).
    function pk() public view returns (bytes32 p) {
        (,, p,,) = _args();
    }

    /// `verifier.sigLength()` at creation: the fixed witness length.
    function sigLength() public view returns (uint256 n) {
        (,,, n,) = _args();
    }

    /// 1 = VAULT, 2 = RECOVERY (the account authorises by address; an unbound signer checks it against `getRoles`).
    function role() public view returns (uint8 r) {
        (,,,, r) = _args();
    }

    function maxFee() external view returns (uint256) {
        return _maxFee;
    }

    /// ETH for gas (the signer pays for itself) and the stake float. A VERIFY frame with empty data lands here and
    /// never approves (plan §10.3.2); `verifyFrame(uint256)` is the only VERIFY entry.
    receive() external payable {}

    // ------------------------------------------------------------------------------------------------ VERIFY -----

    /// VERIFY entry; frame data `abi.encodeCall(verifyFrame, (sigIndex))`. `sigIndex` names the PQ witness entry
    /// (0 in QueueBit). One signature = Path A (PQ verified here), two = Path B (payer key checked here, PQ in
    /// `executePQ`; the payer is the other entry). Approves EXECUTION_AND_PAYMENT: the signer pays for itself.
    function verifyFrame(uint256 sigIndex) external payable {
        _onlyClone();
        uint256 cur = txparam(TxParam.CURRENT_FRAME_INDEX);
        if (frameparam(cur, FrameParam.MODE) != uint256(FrameMode.VERIFY)) revert NotVerifyFrame();
        if (frameparam(cur, FrameParam.ALLOWED_SCOPE) != uint256(Scope.EXECUTION_AND_PAYMENT)) {
            revert ScopeNotSelfVerify();
        }

        uint256 nsig = txparam(TxParam.SIGNATURE_COUNT);
        if (nsig != 1 && nsig != 2) revert BadSignatureCount(nsig);
        if (sigIndex >= nsig) revert BadWitnessEntry(sigIndex);
        (, IPQVerifier v, bytes32 key, uint256 len,) = _args();
        _checkWitnessEntry(sigIndex, len);

        // One SLOAD (slot 0): the payer key and the fee bound.
        address payer = payerKey;
        uint256 bound = _maxFee;
        uint256 fee = txparam(feeParam);
        if (fee > bound) revert FeeTooHigh(fee, bound);

        if (nsig == 2) {
            // Path B. Scheme first: RESOLVED_SIGNER of an ARBITRARY entry halts.
            if (payer == address(0)) revert PathBDisabled();
            uint256 p = 1 - sigIndex;
            if (sigparam(p, SigParam.SCHEME) != SCHEME_SECP256K1 || sigparam(p, SigParam.MSG) != 0) {
                revert BadPayerEntry(p);
            }
            if (address(uint160(sigparam(p, SigParam.RESOLVED_SIGNER))) != payer) revert BadPayerEntry(p);
            _walk(cur, this.executePQ.selector, true, sigIndex);
        } else {
            // Path A.
            _walk(cur, this.relay.selector, false, 0);
            if (!_pqValid(sigIndex, v, key, len)) revert InvalidPQSignature();
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    // --------------------------------------------------------------------------------------------- execution -----

    /// Path B execution entry (the SENDER frame to self): verifies the PQ witness over TXPARAM_SIG_HASH, then
    /// forwards `data` to `target` (the account, or this contract's own admin functions).
    function executePQ(uint256 sigIndex, address target, bytes calldata data) external {
        if (msg.sender != address(this)) revert OnlySelf();
        (address acct, IPQVerifier v, bytes32 key, uint256 len, uint8 r) = _args();
        _checkWitnessEntry(sigIndex, len);
        if (!_pqValid(sigIndex, v, key, len)) revert InvalidPQSignature();
        _forward(acct, r, target, data);
        emit RoleTxExecuted(bytes32(txparam(TxParam.SIG_HASH)), PATH_B);
    }

    /// Path A execution entry: the PQ signature was verified in VERIFY; forwards like `executePQ`.
    function relay(address target, bytes calldata data) external {
        if (msg.sender != address(this)) revert OnlySelf();
        (address acct,,,, uint8 r) = _args();
        _forward(acct, r, target, data);
        emit RoleTxExecuted(bytes32(txparam(TxParam.SIG_HASH)), PATH_A);
    }

    // ------------------------------------------------------------- self-admin (only via executePQ / relay) -----

    function setPayerKey(address newPayerKey) external {
        _onlySelf();
        payerKey = newPayerKey;
        emit PayerKeySet(newPayerKey);
    }

    function setPathA(bool enabled) external {
        _onlySelf();
        pathAEnabled = enabled;
        emit PathASet(enabled);
    }

    function setMaxFee(uint256 newMaxFee) external {
        _onlySelf();
        if (newMaxFee > type(uint96).max) revert InvalidConfig();
        _maxFee = uint96(newMaxFee);
        emit MaxFeeSet(newMaxFee);
    }

    /// Stakes `amount` of this contract's own balance in the ERC-8421 registry (which keys stake on msg.sender).
    function stake(uint32 unstakeDelaySec, uint256 amount) external {
        _onlySelf();
        stakingRegistry.addStake{value: amount}(unstakeDelaySec);
        emit Staked(amount, unstakeDelaySec);
    }

    function unlockStake() external {
        _onlySelf();
        stakingRegistry.unlockStake();
        emit StakeUnlocked();
    }

    function withdrawStake(address payable to) external {
        _onlySelf();
        stakingRegistry.withdrawStake(to);
        emit StakeWithdrawn(to);
    }

    // ------------------------------------------------------------------------------------------- internals -----

    /// `msg.sender == address(this)` also rules out the implementation: nothing can make it its own caller except
    /// a frame transaction with the implementation as `tx.sender`, and its VERIFY entry refuses (`_onlyClone`).
    function _onlySelf() private view {
        if (msg.sender != address(this)) revert OnlySelf();
    }

    function _onlyClone() private view {
        if (address(this) == SELF) revert NotClone();
    }

    /// The clone's immutable args, read from its own code (EXTCODECOPY of ADDRESS: under DELEGATECALL, CODECOPY
    /// would read the implementation). The clone is `tx.sender`, so the access is warm; no storage is read.
    function _args() private view returns (address acct, IPQVerifier v, bytes32 key, uint256 len, uint8 r) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            extcodecopy(address(), m, ARGS_OFFSET, ARGS_LENGTH)
            acct := shr(96, mload(m))
            v := shr(96, mload(add(m, 20)))
            key := mload(add(m, 40))
            len := mload(add(m, 72))
            r := byte(0, mload(add(m, 104)))
        }
    }

    /// The PQ entry must be ARBITRARY, over the canonical sig hash (empty msg), and exactly `len` bytes.
    function _checkWitnessEntry(uint256 sigIndex, uint256 len) private view {
        if (
            sigparam(sigIndex, SigParam.SCHEME) != SCHEME_ARBITRARY || sigparam(sigIndex, SigParam.MSG) != 0
                || sigparam(sigIndex, SigParam.SIGNATURE_LENGTH) != len
        ) revert BadWitnessEntry(sigIndex);
    }

    /// Copies the (already checked) ARBITRARY witness and verifies it against TXPARAM_SIG_HASH.
    function _pqValid(uint256 sigIndex, IPQVerifier v, bytes32 key, uint256 len) private view returns (bool) {
        bytes memory sig = sigdatacopy(0, len, sigIndex);
        return v.verify(key, bytes32(txparam(TxParam.SIG_HASH)), sig);
    }

    /// The frames after `cur`: exactly one SENDER frame, to this contract, no value, calling `selector`
    /// (and for Path B with `executePQ`'s first argument equal to the verified witness index).
    function _walk(uint256 cur, bytes4 selector, bool checkIndex, uint256 sigIndex) private view {
        uint256 i = cur + 1;
        if (txparam(TxParam.FRAME_COUNT) != i + 1) revert BadFrameShape(i);
        if (
            frameparam(i, FrameParam.MODE) != uint256(FrameMode.SENDER)
                || address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET))) != address(this)
                || frameparam(i, FrameParam.VALUE) != 0 || frameparam(i, FrameParam.DATA_LENGTH) < 4
                || bytes4(framedataload(0, i)) != selector
        ) revert BadFrameShape(i);
        if (checkIndex && uint256(framedataload(4, i)) != sigIndex) revert BadFrameShape(i);
    }

    /// Calls `target`: the bound account (any function; it authorises by msg.sender) or, for an unbound signer,
    /// an account whose `getRoles()` names this signer in its role; or this contract's own admin functions.
    /// Nothing else, and never `executePQ` / `relay` again. Reverts bubble up.
    function _forward(address acct, uint8 r, address target, bytes calldata data) private {
        bytes4 sel = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (target == address(this)) {
            if (
                sel != this.setPayerKey.selector && sel != this.setPathA.selector && sel != this.setMaxFee.selector
                    && sel != this.stake.selector && sel != this.unlockStake.selector && sel != this.withdrawStake.selector
            ) revert TargetNotAllowed(target, sel);
        } else if (target != acct && (acct != address(0) || !_namesThis(target, r))) {
            revert TargetNotAllowed(target, sel);
        }
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// Whether `target.getRoles()` names this signer: as `vaultSigner` or `pendingVaultSigner` (role 1) or as
    /// `recoverySigner` (role 2). Any failure (no code, revert, short return data) is "no".
    function _namesThis(address target, uint8 r) private view returns (bool) {
        if (target.code.length == 0) return false;
        (bool ok, bytes memory ret) = target.staticcall(abi.encodeCall(IQueueBitAccountRoles.getRoles, ()));
        if (!ok || ret.length < 160) return false;
        (address vault, address recovery, address pendingVault,,) =
            abi.decode(ret, (address, address, address, uint48, uint32));
        if (r == ROLE_VAULT) return vault == address(this) || pendingVault == address(this);
        return recovery == address(this);
    }
}
