// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {LibPiiHash} from "./LibPiiHash.sol";

/**
 * @title PiiMerkle
 * @notice Append-only depth-20 binary Merkle tree for the Pii shielded pool.
 *
 * Design (SPEC §3):
 *   - Empty leaf = ZERO_VALUE = keccak256("pii-shielded-pool-v1") mod r.
 *     This is a domain-separated non-zero sentinel; a leaf can never be confused
 *     with an empty slot because an attacker cannot construct a preimage for ZERO_VALUE.
 *   - zeros[0] = ZERO_VALUE; zeros[i] = hash2(zeros[i-1], zeros[i-1]).
 *   - Root history: every root ever produced is recorded in
 *     `mapping(uint256 => bool) isKnownRoot`. Roots are PERMANENT — they never
 *     expire. (The 50-root / 7-day window applies only to v2 eligibility trees,
 *     not to the note tree.)
 *   - insert bit 0 = left child (standard incrementing-index append).
 *   - Emits LeafInserted(leafIndex, commitment, newRoot) on each insert.
 *
 * Gas: ~27k per hash2 (Yul), ~0.74M per depth-20 insert (SPEC §3).
 *
 * Golden vectors (SPEC §2, confirmed by Noir 1.0.0-rc.5 + TS + Solidity):
 *   ZERO_VALUE = 0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466
 *   zeros[20]  = 0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7
 */
abstract contract PiiMerkle {
    // ── Constants ─────────────────────────────────────────────────────────────

    uint256 public constant TREE_DEPTH = 20;
    uint256 public constant MAX_LEAVES = 1 << 20; // 1,048,576

    /// @dev BN254 scalar field prime r.
    uint256 internal constant BN254_R =
        0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;

    /// @notice Empty-leaf sentinel: keccak256("pii-shielded-pool-v1") mod r.
    ///   Pre-reduced — no runtime modulo needed.
    uint256 public constant ZERO_VALUE =
        0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466;

    // ── Precomputed zeros (set in constructor, stored as an array) ────────────
    // zeros[0] = ZERO_VALUE; zeros[i] = hash2(zeros[i-1], zeros[i-1]).

    uint256[21] private _zeros;

    // ── Tree storage ──────────────────────────────────────────────────────────

    /// @dev filled_subtrees[i] = the rightmost fully-filled subtree of depth i.
    uint256[21] private _filledSubtrees;

    /// @dev Next available leaf index (0-based).
    uint256 private _nextIndex;

    // ── Root history ──────────────────────────────────────────────────────────

    /// @notice Every root ever produced by this tree is permanently valid.
    ///   isKnownRoot[root] == true iff `root` was ever the active root.
    mapping(uint256 => bool) public isKnownRoot;

    /// @notice The current (most recent) Merkle root.
    uint256 public currentRoot;

    // ── Events ────────────────────────────────────────────────────────────────

    event LeafInserted(uint256 indexed leafIndex, uint256 commitment, uint256 newRoot);

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor() {
        // Build zeros[0..20] from the domain-separated empty-leaf sentinel.
        _zeros[0] = ZERO_VALUE;
        for (uint256 i = 1; i <= TREE_DEPTH; i++) {
            _zeros[i] = LibPiiHash.hash2(_zeros[i - 1], _zeros[i - 1]);
        }

        // Initialize filled subtrees to the zero subtrees.
        for (uint256 i = 0; i <= TREE_DEPTH; i++) {
            _filledSubtrees[i] = _zeros[i];
        }

        // Record the empty-tree root as valid.
        uint256 emptyRoot_ = _zeros[TREE_DEPTH];
        isKnownRoot[emptyRoot_] = true;
        currentRoot = emptyRoot_;
    }

    // ── External views ────────────────────────────────────────────────────────

    /// @notice Returns zeros[i] (the hash of a depth-i subtree of ZERO_VALUE leaves).
    function zeros(uint256 i) external view returns (uint256) {
        require(i <= TREE_DEPTH, "depth");
        return _zeros[i];
    }

    /// @notice Returns zeros[20], the root of the completely empty tree.
    function emptyRoot() external view returns (uint256) {
        return _zeros[TREE_DEPTH];
    }

    /// @notice Returns the next leaf index to be filled.
    function nextIndex() external view returns (uint256) {
        return _nextIndex;
    }

    // ── Internal insertion ────────────────────────────────────────────────────

    /**
     * @notice Insert a commitment into the next leaf slot.
     * @dev Recomputes the path from leaf to root using 20 hash2 calls.
     *      Records the new root permanently in isKnownRoot.
     *      Emits LeafInserted.
     * @param commitment The leaf value (must be a valid Pii note commitment).
     * @return leafIndex The 0-based index of the newly inserted leaf.
     * @return newRoot   The Merkle root after the insertion.
     */
    function _insert(uint256 commitment) internal returns (uint256 leafIndex, uint256 newRoot) {
        uint256 idx = _nextIndex;
        require(idx < MAX_LEAVES, "tree full");
        _nextIndex = idx + 1;

        uint256 currentHash = commitment;

        for (uint256 i = 0; i < TREE_DEPTH; i++) {
            uint256 left;
            uint256 right;
            if ((idx >> i) & 1 == 0) {
                // Current node is a left child; right sibling is the zero subtree.
                left = currentHash;
                right = _zeros[i];
                _filledSubtrees[i] = currentHash;
            } else {
                // Current node is a right child; left sibling is the saved filled subtree.
                left = _filledSubtrees[i];
                right = currentHash;
            }
            currentHash = LibPiiHash.hash2(left, right);
        }

        // Record the new root permanently.
        isKnownRoot[currentHash] = true;
        currentRoot = currentHash;

        emit LeafInserted(idx, commitment, currentHash);
        return (idx, currentHash);
    }
}
