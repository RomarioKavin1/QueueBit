// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DepsRegistry
/// @notice Ported from LeanPool `contracts/src/v2/DepsRegistry.sol` @ 53732b1 (MIT), unchanged in behaviour.
///
/// LeanPool v2: the on-chain stand-in for EIP-8288's block-level `recursive_stark`.
///
/// A bonded aggregator posts `root`, the Merkle root (MerkleLib) over `keccak256(triple)` of a batch's sorted,
/// deduplicated EIP-8288 dependencies, after checking every raw leanSPHINCS signature natively (mode 0). It also
/// writes the root into a small ring for each wallet with a tx in the batch. Once its recursive leanVM STARK over
/// exactly those dependencies exists (mode 1), it attaches `keccak256(stark)`; nodes serve the STARK and anyone can
/// check it off-chain (`services/leanpool-node` verify-batch).
///
/// Why per-wallet rings: a wallet's VERIFY frame reads `rings[aggregator][wallet][i]`, whose slot is
/// `keccak256(wallet ‖ keccak256(aggregator ‖ RINGS_SLOT)) + i`: storage associated with the wallet (ERC-7562
/// STO-021). The alt mempool lets an UNSTAKED sender read it, because one write to it can only invalidate that
/// wallet's own pending txs. Invalidating N wallets costs N writes, so no stake is needed to price it.
///
/// Trust: the EVM cannot verify leanVM signatures or STARKs, so there is no on-chain fraud game here (v1's
/// BatchRegistry had one). Each wallet names the aggregator whose ring it reads; a stranger's writes land in the
/// stranger's own namespace. The bond is stake on the aggregator's batches.
contract DepsRegistry {
    struct Batch {
        uint64 postedAt;
        uint16 count;
        bool posted;
        bytes32 proofHash;
    }

    uint8 public constant RING = 8;
    /// Storage slot of `rings` (checked by the Forge test that pins the association layout).
    uint256 public constant RINGS_SLOT = 2;

    uint256 public immutable minBond;
    mapping(address => uint256) public bonds; // slot 0
    mapping(address aggregator => mapping(bytes32 root => Batch)) public batches; // slot 1
    mapping(address aggregator => mapping(address wallet => bytes32[8])) internal rings; // slot 2 = RINGS_SLOT
    mapping(address aggregator => uint256) public batchCount; // slot 3

    event Bonded(address indexed aggregator, uint256 total);
    event RootPosted(bytes32 indexed root, address indexed aggregator, uint16 count, uint8 ring);
    event ProofAttached(bytes32 indexed root, address indexed aggregator, bytes32 proofHash);

    error NotBonded();
    error RootExists();
    error EmptyBatch();
    error NotPoster();
    error ProofExists();
    error EmptyProof();

    constructor(uint256 minBond_) {
        minBond = minBond_;
    }

    function bond() external payable {
        bonds[msg.sender] += msg.value;
        emit Bonded(msg.sender, bonds[msg.sender]);
    }

    /// Posts a batch root and writes it into ring position `batchCount % RING` of every wallet in the batch.
    /// Returns that position: it goes into each tx's witness.
    function postRoot(bytes32 root, uint16 count, address[] calldata wallets) external returns (uint8 ring) {
        if (bonds[msg.sender] < minBond) revert NotBonded();
        if (count == 0 || wallets.length == 0) revert EmptyBatch();
        Batch storage b = batches[msg.sender][root];
        if (b.posted) revert RootExists();
        b.postedAt = uint64(block.timestamp);
        b.count = count;
        b.posted = true;

        ring = uint8(batchCount[msg.sender]++ % RING);
        mapping(address => bytes32[8]) storage mine = rings[msg.sender];
        for (uint256 i; i < wallets.length; ++i) {
            mine[wallets[i]][ring] = root;
        }
        emit RootPosted(root, msg.sender, count, ring);
    }

    /// The hash of the batch's mode 1 STARK (lean-pq Aggregate bytes). Posted once, by the root's aggregator.
    function attachProof(bytes32 root, bytes32 proofHash) external {
        Batch storage b = batches[msg.sender][root];
        if (!b.posted) revert NotPoster();
        if (proofHash == bytes32(0)) revert EmptyProof();
        if (b.proofHash != bytes32(0)) revert ProofExists();
        b.proofHash = proofHash;
        emit ProofAttached(root, msg.sender, proofHash);
    }

    /// What a wallet's VERIFY frame reads: one slot associated with the wallet.
    function rootAt(address aggregator, address wallet, uint8 i) external view returns (bytes32) {
        return rings[aggregator][wallet][i];
    }

    function isPosted(address aggregator, bytes32 root) external view returns (bool) {
        return batches[aggregator][root].posted;
    }
}
