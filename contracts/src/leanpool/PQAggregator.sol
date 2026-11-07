// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPQVerifier} from "../interfaces/IPQVerifier.sol";
import {DepsRegistry} from "./DepsRegistry.sol";

/// @title PQAggregator
/// @notice A LeanPool aggregator whose authority is a hash-based (SPHINCS- C13) key instead of an ECDSA EOA.
///
/// Accounts trust every root their policy's aggregator posts into their DepsRegistry ring (KeystoreValidator reads
/// `registry.rootAt(policy.aggregator, account, ring)`), so whoever controls the aggregator address can approve any
/// owner tx. With an EOA as the aggregator, breaking its ECDSA key is an account takeover after Q-day. This contract
/// is the bonded aggregator instead: `msg.sender` of `bond`, `postRoot` and `attachProof` in the registry is this
/// contract, and it acts only on a C13 signature verified here, in execution (C13Verifier, ~110k gas).
///
/// Anyone may submit a signed call and pay its gas (the LeanPool node uses an ordinary EOA for that). The gas payer's
/// key authorizes nothing: it cannot forge, alter or replay a root, a proof hash, a rotation or a withdrawal.
///
/// What is signed: an EIP-712 digest, domain {name "QueueBit PQAggregator", version "1", chainId, this contract},
/// over the operation's fields, the registry, and a nonce. Each operation kind has its own nonce lane (posts, proof
/// hashes, admin), so the node's batch loop and prover loop never race for one nonce:
///   Post(address registry,uint256 nonce,bytes32 root,uint16 count,address[] wallets)
///   AttachProof(address registry,uint256 nonce,bytes32 root,bytes32 proofHash)
///   RotateKey(uint256 nonce,bytes32 newPublicKey)
///   Withdraw(uint256 nonce,address to,uint256 amount)
///
/// Signature budget: C13 is a few-time scheme, 2^22 signatures per key at the claimed 128-bit level
/// (SIGNATURE_BUDGET of the pq-signer package). Every accepted signature counts against the current key
/// (`signaturesUsed`); posts and proof hashes stop `ADMIN_RESERVE` short of the budget so a rotation (or a withdrawal)
/// can still be signed by the old key. `rotateKey` installs a fresh key and resets the count. The on-chain count is a
/// lower bound: a signature that never lands (a failed or replaced tx) still used the key, so the signer keeps its
/// own count too and rotates well before either limit.
///
/// The bond: DepsRegistry v2 has no unbond, so a bond stays in the registry for good; `bond()` is permissionless
/// (adding stake is harmless). The only funds this contract can release are its own balance, via a PQ-signed
/// `withdraw`.
contract PQAggregator {
    /// C13's per-key signature budget at the claimed 128-bit level (2^22).
    uint256 public constant C13_SIGNATURE_BUDGET = 1 << 22;
    /// Signatures kept back for `rotateKey` / `withdraw` once posts and proof hashes have used the rest.
    uint256 public constant ADMIN_RESERVE = 16;

    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant POST_TYPEHASH =
        keccak256("Post(address registry,uint256 nonce,bytes32 root,uint16 count,address[] wallets)");
    bytes32 public constant ATTACH_TYPEHASH =
        keccak256("AttachProof(address registry,uint256 nonce,bytes32 root,bytes32 proofHash)");
    bytes32 public constant ROTATE_TYPEHASH = keccak256("RotateKey(uint256 nonce,bytes32 newPublicKey)");
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("Withdraw(uint256 nonce,address to,uint256 amount)");
    bytes32 private constant NAME_HASH = keccak256("QueueBit PQAggregator");
    bytes32 private constant VERSION_HASH = keccak256("1");

    DepsRegistry public immutable registry;
    IPQVerifier public immutable verifier;
    /// Signatures per key this deployment allows (at most C13_SIGNATURE_BUDGET; smaller in tests).
    uint256 public immutable signatureBudget;

    /// The C13 public key, pkSeed(16) ‖ pkRoot(16).
    bytes32 public publicKey;
    /// Signatures of the current key accepted here.
    uint256 public signaturesUsed;
    uint256 public postNonce;
    uint256 public attachNonce;
    uint256 public adminNonce;

    event RootPosted(bytes32 indexed root, uint256 nonce, uint8 ring);
    event ProofAttached(bytes32 indexed root, uint256 nonce, bytes32 proofHash);
    event KeyRotated(bytes32 indexed oldPublicKey, bytes32 indexed newPublicKey, uint256 nonce);
    event Withdrawn(address indexed to, uint256 amount, uint256 nonce);

    error BadSignature();
    error BudgetExhausted();
    error BadBudget();
    error ZeroKey();
    error WithdrawFailed();

    constructor(DepsRegistry registry_, IPQVerifier verifier_, bytes32 publicKey_, uint256 signatureBudget_) {
        if (publicKey_ == bytes32(0)) revert ZeroKey();
        if (signatureBudget_ <= ADMIN_RESERVE || signatureBudget_ > C13_SIGNATURE_BUDGET) revert BadBudget();
        registry = registry_;
        verifier = verifier_;
        publicKey = publicKey_;
        signatureBudget = signatureBudget_;
    }

    // ----------------------------------------------------------------------------------------- operations ------

    /// Posts `root` into the ring of every wallet in `wallets` (DepsRegistry.postRoot, as this aggregator).
    function post(bytes32 root, uint16 count, address[] calldata wallets, bytes calldata sig)
        external
        returns (uint8 ring)
    {
        uint256 nonce = postNonce;
        _authorize(postDigest(root, count, wallets, nonce), sig, false);
        postNonce = nonce + 1;
        ring = registry.postRoot(root, count, wallets);
        emit RootPosted(root, nonce, ring);
    }

    /// Attaches the batch STARK's hash to `root` (DepsRegistry.attachProof). PQ-signed: the registry keeps the first
    /// hash attached to a root, so an unauthenticated attach would let anyone overwrite the audit trail first.
    function attachProof(bytes32 root, bytes32 proofHash, bytes calldata sig) external {
        uint256 nonce = attachNonce;
        _authorize(attachDigest(root, proofHash, nonce), sig, false);
        attachNonce = nonce + 1;
        registry.attachProof(root, proofHash);
        emit ProofAttached(root, nonce, proofHash);
    }

    /// Replaces the key (signed by the current one) and resets the signature count.
    function rotateKey(bytes32 newPublicKey, bytes calldata sig) external {
        if (newPublicKey == bytes32(0)) revert ZeroKey();
        uint256 nonce = adminNonce;
        _authorize(rotateDigest(newPublicKey, nonce), sig, true);
        adminNonce = nonce + 1;
        bytes32 old = publicKey;
        publicKey = newPublicKey;
        signaturesUsed = 0;
        emit KeyRotated(old, newPublicKey, nonce);
    }

    /// Sends `amount` of this contract's own balance to `to`. (A bond never comes back: DepsRegistry has no unbond.)
    function withdraw(address payable to, uint256 amount, bytes calldata sig) external {
        uint256 nonce = adminNonce;
        _authorize(withdrawDigest(to, amount, nonce), sig, true);
        adminNonce = nonce + 1;
        emit Withdrawn(to, amount, nonce);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    /// Bonds `msg.value` in the registry as this aggregator. Permissionless: stake can only be added.
    function bond() external payable {
        registry.bond{value: msg.value}();
    }

    // ------------------------------------------------------------------------------------------- digests -------

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function postDigest(bytes32 root, uint16 count, address[] calldata wallets, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        bytes32 walletsHash = keccak256(abi.encodePacked(wallets)); // EIP-712 address[]: 32-byte words, hashed
        return _typed(keccak256(abi.encode(POST_TYPEHASH, address(registry), nonce, root, count, walletsHash)));
    }

    function attachDigest(bytes32 root, bytes32 proofHash, uint256 nonce) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(ATTACH_TYPEHASH, address(registry), nonce, root, proofHash)));
    }

    function rotateDigest(bytes32 newPublicKey, uint256 nonce) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(ROTATE_TYPEHASH, nonce, newPublicKey)));
    }

    function withdrawDigest(address to, uint256 amount, uint256 nonce) public view returns (bytes32) {
        return _typed(keccak256(abi.encode(WITHDRAW_TYPEHASH, nonce, to, amount)));
    }

    /// Signatures the current key may still spend on posts and proof hashes.
    function remainingPostSignatures() external view returns (uint256) {
        uint256 cap = signatureBudget - ADMIN_RESERVE;
        return signaturesUsed >= cap ? 0 : cap - signaturesUsed;
    }

    // ------------------------------------------------------------------------------------------ internal -------

    function _typed(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
    }

    /// Checks the budget, verifies `sig` over `digest` with the current key, and counts it.
    function _authorize(bytes32 digest, bytes calldata sig, bool admin) internal {
        uint256 used = signaturesUsed;
        if (used >= (admin ? signatureBudget : signatureBudget - ADMIN_RESERVE)) revert BudgetExhausted();
        if (!verifier.verify(publicKey, digest, sig)) revert BadSignature();
        signaturesUsed = used + 1;
    }
}
