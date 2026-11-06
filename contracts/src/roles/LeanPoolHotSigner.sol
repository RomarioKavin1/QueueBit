// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HegotaSupport, Devnet} from "@forshtat/hegota-support/contracts/HegotaSupport.sol";
import {Scope, TxParam, FrameParam, FrameMode, SigParam} from "@forshtat/hegota-support/contracts/Params.sol";
import {IQueueBitAccount} from "../account/IQueueBitAccount.sol";
import {LeanPoolMerkle} from "../leanpool/LeanPoolMerkle.sol";
import {FeeProfile} from "./FeeProfile.sol";

interface IDepsRegistryRing {
    function rootAt(address aggregator, address wallet, uint8 i) external view returns (bytes32);
}

/// The account's everyday entry for a PQ hot signer (`QueueBitAccountImpl.hotExecuteFrom`).
interface IHotExecuteFrom {
    function hotExecuteFrom(uint256 declaredUsd, IQueueBitAccount.Call[] calldata calls) external;
}

/// @title LeanPoolHotSigner
/// @notice A post-quantum everyday key for a QueueBit account. The key is leanVM leanSPHINCS; its signatures are
///         verified off-chain by LeanPool nodes, batched, and committed as a Merkle root into this signer's own ring
///         in `DepsRegistry` (LeanPool v2). This contract's VERIFY frame only checks that its EIP-8288 dependency is in
///         such a root, then its SENDER frame spends through `account.hotExecuteFrom`, under exactly the everyday
///         limits of the account (rolling USD cap, per-payment maximum, allowlists, freeze, bunker).
///
///         Trust: the aggregator named in the args can approve a transaction the key did not sign. That is bounded
///         by the account's everyday limits, the same bound the threat model accepts for a leaked everyday key, and
///         the Vault replaces the signer (`vaultSetPQHotSigner`) to change aggregator. Every batch's recursive STARK
///         hash is attached on-chain for anyone to audit (`services/leanpool-node` verify-batch).
///
///         Deployment: Solady ERC-1167 clones with immutable args `account ‖ registry ‖ aggregator ‖ pk ‖ maxFee`
///         (`LeanPoolHotSignerFactory`). No storage at all: VERIFY reads only the clone's own code and its ring slot
///         `rings[aggregator][this]`, storage associated with the sender (ERC-7562 STO-021), so the ERC-8421 alt
///         mempool admits it unstaked. The canonical mempool refuses the read (`StorageReadNonSender`).
///
///         Transaction shape:
///           frames     [VERIFY 0x3 (target null = this, data = triple), SENDER(this, execute(declaredUsd, calls))]
///           signatures [ARBITRARY witness abi.encode(bytes32 root, uint8 ring, bytes32[] proof), msg ∅]
///         The triple is `(0x10, 0, vk)`: "a leanSPHINCS signature by vk over this tx's SIG_HASH" (EIP-8288; zero
///         data_hash = own SIG_HASH). The signature hash covers the triple (frame data) but not the witness (empty
///         msg), which the LeanPool node fills in after the batch is posted. The LeanPool node binds the triple's
///         key to the sender with `vk()`, as it does for LeanPool's `LeanWallet8288`.
/// @dev    VERIFY-path rules (as `PQRoleSigner`): SIGNATURE_LENGTH checked before SIGDATACOPY, no RESOLVED_SIGNER of
///         an ARBITRARY entry, no logs, no writes; one STATICCALL, to the registry's `rootAt`.
contract LeanPoolHotSigner is HegotaSupport {
    uint256 internal constant LEANSPHINCS_SCHEME = 0x10;
    uint8 internal constant RING = 8;
    /// A proof of up to 16 levels: a batch holds at most 16 dependencies (EIP-8288 MAX_LEANSIG_DEPS_PER_WRAPPER), so
    /// real proofs have at most 4; the bound only caps the copy.
    uint256 internal constant MAX_PROOF = 16;
    /// abi.encode(bytes32, uint8, bytes32[]) with an empty proof: root, ring, offset, length.
    uint256 internal constant MIN_WITNESS = 128;
    uint256 private constant SCHEME_ARBITRARY = 0;

    /// Solady ERC-1167-with-args runtime: 0x2d bytes of proxy code, then the args.
    uint256 private constant ARGS_OFFSET = 0x2d;
    /// account (20) ‖ registry (20) ‖ aggregator (20) ‖ pk (32) ‖ maxFee (12).
    uint256 internal constant ARGS_LENGTH = 104;

    /// The TXPARAM that `maxFee` bounds (`MAX_FEE` or `MAX_COST`, checked against the devnet by `FeeProfile`).
    TxParam public immutable feeParam;
    address private immutable SELF;

    event HotTxExecuted(bytes32 indexed sigHash, uint256 declaredUsd);

    error NotClone();
    error OnlySelf();
    error NotVerifyFrame();
    error ScopeNotSelfVerify();
    error BadPayload();
    error BadScheme();
    error NotOwnSigHash();
    error WrongKey();
    error BadSignatureCount(uint256 count);
    error BadWitnessEntry();
    error BadRingPosition();
    error RootNotValid();
    error NotIncluded();
    error BadFrameShape(uint256 frameIndex);
    error FeeTooHigh(uint256 fee, uint256 maxFee);

    constructor(Devnet devnet_, TxParam feeParam_) HegotaSupport(devnet_) {
        FeeProfile.check(devnet_, feeParam_);
        feeParam = feeParam_;
        SELF = address(this);
    }

    // ---------------------------------------------------------------------------------------------- views ------

    function account() public view returns (address a) {
        (a,,,,) = _args();
    }

    function registry() public view returns (address r) {
        (, r,,,) = _args();
    }

    /// The aggregator whose roots this signer accepts.
    function aggregator() public view returns (address g) {
        (,, g,,) = _args();
    }

    /// The 32-byte leanVM leanSPHINCS public key (EIP-8288 verification_key_hash). `vk()` is LeanPool's name for it.
    function vk() public view returns (bytes32 k) {
        (,,, k,) = _args();
    }

    /// QueueBit's name for the PQ key (`QueueBitAccountBase` SameRoleKey reads `pk()`).
    function pk() external view returns (bytes32) {
        return vk();
    }

    /// Upper bound on `txparam(feeParam)`: this signer's own ETH at risk per transaction.
    function maxFee() public view returns (uint256 f) {
        (,,,, f) = _args();
    }

    /// ETH for gas: the signer pays for itself.
    receive() external payable {}

    // --------------------------------------------------------------------------------------------- VERIFY ------

    /// VERIFY entry: the frame data is the 96-byte EIP-8288 triple (no selector; its first word is the scheme, so
    /// its first four bytes are zero and match no function).
    fallback() external payable {
        if (address(this) == SELF) revert NotClone();
        uint256 cur = txparam(TxParam.CURRENT_FRAME_INDEX);
        if (frameparam(cur, FrameParam.MODE) != uint256(FrameMode.VERIFY)) revert NotVerifyFrame();
        if (frameparam(cur, FrameParam.ALLOWED_SCOPE) != uint256(Scope.EXECUTION_AND_PAYMENT)) {
            revert ScopeNotSelfVerify();
        }
        if (msg.data.length != 96) revert BadPayload();
        (uint256 scheme, bytes32 dataHash, bytes32 key) = abi.decode(msg.data, (uint256, bytes32, bytes32));
        if (scheme != LEANSPHINCS_SCHEME) revert BadScheme(); // also catches non-zero padding
        if (dataHash != bytes32(0)) revert NotOwnSigHash();
        (, address reg, address agg, bytes32 ownKey, uint256 bound) = _args();
        if (key != ownKey) revert WrongKey();

        uint256 fee = txparam(feeParam);
        if (fee > bound) revert FeeTooHigh(fee, bound);
        _walk(cur);

        if (txparam(TxParam.SIGNATURE_COUNT) != 1) revert BadSignatureCount(txparam(TxParam.SIGNATURE_COUNT));
        // Scheme and msg first: SIGDATACOPY of a non-ARBITRARY entry halts on ethrex.
        if (sigparam(0, SigParam.SCHEME) != SCHEME_ARBITRARY || sigparam(0, SigParam.MSG) != 0) {
            revert BadWitnessEntry();
        }
        uint256 len = sigparam(0, SigParam.SIGNATURE_LENGTH);
        if (len < MIN_WITNESS || len > MIN_WITNESS + 32 * MAX_PROOF || len % 32 != 0) revert BadWitnessEntry();
        (bytes32 root, uint8 ring, bytes32[] memory proof) =
            abi.decode(sigdatacopy(0, len, 0), (bytes32, uint8, bytes32[]));
        if (ring >= RING) revert BadRingPosition();
        if (root == bytes32(0) || IDepsRegistryRing(reg).rootAt(agg, address(this), ring) != root) {
            revert RootNotValid();
        }
        bytes32 leaf = keccak256(abi.encodePacked(LEANSPHINCS_SCHEME, bytes32(txparam(TxParam.SIG_HASH)), key));
        if (!LeanPoolMerkle.verify(proof, root, leaf)) revert NotIncluded();
        approve(Scope.EXECUTION_AND_PAYMENT);
    }

    // ------------------------------------------------------------------------------------------ execution ------

    /// The SENDER frame: spends through the account's everyday tier. Every limit is enforced there, in execution.
    function execute(uint256 declaredUsd, IQueueBitAccount.Call[] calldata calls) external {
        if (msg.sender != address(this)) revert OnlySelf();
        IHotExecuteFrom(account()).hotExecuteFrom(declaredUsd, calls);
        emit HotTxExecuted(bytes32(txparam(TxParam.SIG_HASH)), declaredUsd);
    }

    // ------------------------------------------------------------------------------------------ internals ------

    /// The clone's immutable args, read from its own code (EXTCODECOPY of ADDRESS: under DELEGATECALL, CODECOPY
    /// would read the implementation).
    function _args() private view returns (address acct, address reg, address agg, bytes32 key, uint256 bound) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            extcodecopy(address(), m, ARGS_OFFSET, ARGS_LENGTH)
            acct := shr(96, mload(m))
            reg := shr(96, mload(add(m, 20)))
            agg := shr(96, mload(add(m, 40)))
            key := mload(add(m, 60))
            bound := shr(160, mload(add(m, 92)))
        }
    }

    /// Exactly one more frame: SENDER, to this contract, no value, calling `execute`.
    function _walk(uint256 cur) private view {
        uint256 i = cur + 1;
        if (txparam(TxParam.FRAME_COUNT) != i + 1) revert BadFrameShape(i);
        if (
            frameparam(i, FrameParam.MODE) != uint256(FrameMode.SENDER)
                || address(uint160(frameparam(i, FrameParam.RESOLVED_TARGET))) != address(this)
                || frameparam(i, FrameParam.VALUE) != 0 || frameparam(i, FrameParam.DATA_LENGTH) < 4
                || bytes4(framedataload(0, i)) != this.execute.selector
        ) revert BadFrameShape(i);
    }
}
