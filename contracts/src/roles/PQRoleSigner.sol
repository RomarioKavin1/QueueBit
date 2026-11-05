// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam, FrameMode, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {IStakingRegistry} from "../interfaces/IStakingRegistry.sol";

/// @title PQRoleSigner
/// @notice The only address that may call a LEAKED account's `vault*` / `recovery*` entry points: its own EIP-8141
///         sender whose authority is a post-quantum key (plan `10-contracts.md` §10.3.6, §10.5.2, §10.6). Deployed
///         instances are the `VaultSigner` (role 1) and `RecoverySigner` (role 2) of sections 20/30/40.
///
///         Transaction shapes (frames package builders `roleSignerPathBTx` / `roleSignerPathATx`):
///           Path B (public mempool): [VERIFY 0x3 (this, verifyFrame(0)), SENDER(this, executePQ(0, target, data))],
///                                    signatures [ARBITRARY PQ witness (sigLength B, msg ∅), SECP256K1 payerKey (msg ∅)].
///                                    VERIFY checks the pinned payer key; the PQ signature is checked in `executePQ`.
///           Path A (staked, alt):    [VERIFY 0x3 (this, verifyFrame(0)), SENDER(this, relay(target, data))],
///                                    signatures [ARBITRARY PQ witness]. The PQ signature is checked inside VERIFY.
///         Both signatures sign TXPARAM_SIG_HASH, which commits to every frame (so to `target` and `data`).
///
/// @dev    VERIFY-path rules (`10-contracts.md` "Devnet review amendments"): reads only this contract's own storage
///         (`payerKey`, `maxFee`), calls nothing but the opcode helpers and (Path A) the stateless verifier; never
///         SIGDATACOPYs a SECP256K1 entry (halts on ethrex); never reads RESOLVED_SIGNER of an ARBITRARY entry (halts);
///         never reads STATUS / *_GAS_USED of a running frame; checks SIGNATURE_LENGTH before SIGDATACOPY (a short
///         entry would be zero-padded). `pk`, `verifier`, `sigLength` are immutable: rotating the PQ key or scheme
///         means deploying a new instance and installing it through the account.
contract PQRoleSigner is HegotaSupport {
    // -------------------------------------------------------------------------------------------- constants ------

    uint8 public constant ROLE_VAULT = 1;
    uint8 public constant ROLE_RECOVERY = 2;

    uint8 public constant PATH_A = 1;
    uint8 public constant PATH_B = 2;

    uint256 private constant SCHEME_ARBITRARY = 0;
    uint256 private constant SCHEME_SECP256K1 = 1;

    // ------------------------------------------------------------------------------------------- immutables ------

    /// The LEAKED account this signer serves (the only external call target).
    address public immutable account;
    /// 1 = VAULT, 2 = RECOVERY (informational; the account authorises by address).
    uint8 public immutable role;
    /// Stateless scheme adapter.
    IPQVerifier public immutable verifier;
    /// 32-byte PQ public key, convention per `IPQVerifier` (C13: pkSeed ‖ pkRoot).
    bytes32 public immutable pk;
    /// `verifier.sigLength()` at construction: the fixed witness length.
    uint256 public immutable sigLength;
    /// ERC-8421 staking registry used by `stake` / `unlockStake` / `withdrawStake`.
    IStakingRegistry public immutable stakingRegistry;
    /// The TXPARAM that `maxFee` bounds: `MAX_FEE` (0x04, the EIP's total fee budget in wei) or, on the
    /// `ethrex-eip8141-tracer` devnet where 0x04 is per-gas, `MAX_COST` (0x06, ethrex's maximum cost in wei).
    TxParam public immutable feeParam;

    // ---------------------------------------------------------------------------------------------- storage ------

    /// Path B pinned ECDSA key (on the vault device); address(0) disables Path B.
    address public payerKey;
    /// Set by the role once staked; informational for the extension (Path A is valid whenever the PQ signature is).
    bool public pathAEnabled;
    /// Upper bound on `txparam(feeParam)`: the signer's own ETH at risk per transaction.
    uint256 public maxFee;

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

    /// @param devnet_          opcode helper set (chain-specific opcode bytes; plan §20 §2.2: never hard-code 0xb5)
    /// @param account_         the LEAKED account
    /// @param role_            1 = VAULT, 2 = RECOVERY
    /// @param verifier_        a fixed-length `IPQVerifier`
    /// @param pk_              PQ public key
    /// @param payerKey_        Path B payer key (address(0) = Path B off)
    /// @param maxFee_          initial fee bound (wei)
    /// @param feeParam_        `TxParam.MAX_FEE` or `TxParam.MAX_COST`
    /// @param stakingRegistry_ ERC-8421 staking registry
    constructor(
        Devnet devnet_,
        address account_,
        uint8 role_,
        IPQVerifier verifier_,
        bytes32 pk_,
        address payerKey_,
        uint256 maxFee_,
        TxParam feeParam_,
        IStakingRegistry stakingRegistry_
    ) payable HegotaSupport(devnet_) {
        if (account_ == address(0) || (role_ != ROLE_VAULT && role_ != ROLE_RECOVERY)) revert InvalidConfig();
        if (address(verifier_).code.length == 0 || pk_ == bytes32(0)) revert InvalidConfig();
        if (feeParam_ != TxParam.MAX_FEE && feeParam_ != TxParam.MAX_COST) revert InvalidConfig();
        uint256 len = verifier_.sigLength();
        // VERIFY compares SIGNATURE_LENGTH to an exact value; a variable-length scheme needs its own padding rule.
        if (len == 0) revert InvalidConfig();
        account = account_;
        role = role_;
        verifier = verifier_;
        pk = pk_;
        sigLength = len;
        stakingRegistry = stakingRegistry_;
        feeParam = feeParam_;
        payerKey = payerKey_;
        maxFee = maxFee_;
        emit PayerKeySet(payerKey_);
        emit MaxFeeSet(maxFee_);
    }

    /// ETH for gas (the signer pays for itself) and the stake float. A VERIFY frame with empty data lands here and
    /// never approves (plan §10.3.2); `verifyFrame(uint256)` is the only VERIFY entry.
    receive() external payable {}

    // ------------------------------------------------------------------------------------------------ VERIFY -----

    /// VERIFY entry; frame data `abi.encodeCall(verifyFrame, (sigIndex))`. `sigIndex` names the PQ witness entry
    /// (0 in LEAKED). One signature = Path A (PQ verified here), two = Path B (payer key checked here, PQ in
    /// `executePQ`; the payer is the other entry). Approves EXECUTION_AND_PAYMENT: the signer pays for itself.
    function verifyFrame(uint256 sigIndex) external payable {
        uint256 cur = txparam(TxParam.CURRENT_FRAME_INDEX);
        if (frameparam(cur, FrameParam.MODE) != uint256(FrameMode.VERIFY)) revert NotVerifyFrame();
        if (frameparam(cur, FrameParam.ALLOWED_SCOPE) != uint256(Scope.EXECUTION_AND_PAYMENT)) {
            revert ScopeNotSelfVerify();
        }

        uint256 nsig = txparam(TxParam.SIGNATURE_COUNT);
        if (nsig != 1 && nsig != 2) revert BadSignatureCount(nsig);
        if (sigIndex >= nsig) revert BadWitnessEntry(sigIndex);
        _checkWitnessEntry(sigIndex);

        uint256 fee = txparam(feeParam);
        uint256 bound = maxFee;
        if (fee > bound) revert FeeTooHigh(fee, bound);

        if (nsig == 2) {
            // Path B. Scheme first: RESOLVED_SIGNER of an ARBITRARY entry halts.
            address payer = payerKey;
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
            if (!_pqValid(sigIndex)) revert InvalidPQSignature();
        }
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    // --------------------------------------------------------------------------------------------- execution -----

    /// Path B execution entry (the SENDER frame to self): verifies the PQ witness over TXPARAM_SIG_HASH, then
    /// forwards `data` to `target` (the account, or this contract's own admin functions).
    function executePQ(uint256 sigIndex, address target, bytes calldata data) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _checkWitnessEntry(sigIndex);
        if (!_pqValid(sigIndex)) revert InvalidPQSignature();
        _forward(target, data);
        emit RoleTxExecuted(bytes32(txparam(TxParam.SIG_HASH)), PATH_B);
    }

    /// Path A execution entry: the PQ signature was verified in VERIFY; forwards like `executePQ`.
    function relay(address target, bytes calldata data) external {
        if (msg.sender != address(this)) revert OnlySelf();
        _forward(target, data);
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
        maxFee = newMaxFee;
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

    function _onlySelf() private view {
        if (msg.sender != address(this)) revert OnlySelf();
    }

    /// The PQ entry must be ARBITRARY, over the canonical sig hash (empty msg), and exactly `sigLength` bytes.
    function _checkWitnessEntry(uint256 sigIndex) private view {
        if (
            sigparam(sigIndex, SigParam.SCHEME) != SCHEME_ARBITRARY || sigparam(sigIndex, SigParam.MSG) != 0
                || sigparam(sigIndex, SigParam.SIGNATURE_LENGTH) != sigLength
        ) revert BadWitnessEntry(sigIndex);
    }

    /// Copies the (already checked) ARBITRARY witness and verifies it against TXPARAM_SIG_HASH.
    function _pqValid(uint256 sigIndex) private view returns (bool) {
        bytes memory sig = sigdatacopy(0, sigLength, sigIndex);
        return verifier.verify(pk, bytes32(txparam(TxParam.SIG_HASH)), sig);
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

    /// Calls `target`: the account (any function; it authorises by msg.sender), or this contract's own admin
    /// functions. Nothing else, and never `executePQ` / `relay` again. Reverts bubble up.
    function _forward(address target, bytes calldata data) private {
        bytes4 sel = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (target == address(this)) {
            if (
                sel != this.setPayerKey.selector && sel != this.setPathA.selector && sel != this.setMaxFee.selector
                    && sel != this.stake.selector && sel != this.unlockStake.selector && sel != this.withdrawStake.selector
            ) revert TargetNotAllowed(target, sel);
        } else if (target != account) {
            revert TargetNotAllowed(target, sel);
        }
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
