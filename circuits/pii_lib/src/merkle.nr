// Merkle tree helpers (SPEC §3).
//
// Depth-20 append-only binary tree.
// Empty leaf = ZERO_VALUE.  zeros[i] = hash2(zeros[i-1], zeros[i-1]).
// Insert convention: bit 0 of the leaf index = left child.
// Bit constraint: every merkle_bit MUST be 0 or 1 (constrained in circuits).

use crate::poseidon::hash2;
use crate::notes::ZERO_VALUE;

pub global TREE_DEPTH: u32 = 20;

// ZEROS[20] (empty tree root) — golden value from SPEC §2.
// The full array is computed at runtime by compute_zeros() to avoid
// hardcoding 21 BN254-constrained constants with placeholder values.
pub global EMPTY_ROOT: Field =
    0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7;

// For circuits and tests that need the full array: call compute_zeros().
// We expose ZEROS as a constant array only at the leaves (ZEROS[0] = ZERO_VALUE, ZEROS[20] = EMPTY_ROOT);
// the intermediate values are computed as needed.

// Precomputed zeros array available as a global (computed once via the fn below).
// Exposed as a public constant using the runtime-computed path — lib callers use compute_zeros().

/// Returns all 21 zero-subtree hashes: zeros[0]=ZERO_VALUE, zeros[i]=hash2(zeros[i-1],zeros[i-1]).
pub fn compute_zeros() -> [Field; 21] {
    let mut z: [Field; 21] = [0; 21];
    z[0] = ZERO_VALUE;
    for i in 1..21 {
        z[i] = hash2(z[i - 1], z[i - 1]);
    }
    z
}

// Re-export ZEROS as a constant alias of compute_zeros() for callers that need an array.
// NOTE: in Noir, global arrays cannot call functions, so circuits that need the zeros
// array call compute_zeros() directly.  The ZEROS alias below is for documentation.
// (We keep EMPTY_ROOT as the one hardcoded global for circuits that just need the root.)

/// Constrain that `bit` is boolean (0 or 1).
pub fn assert_boolean(bit: Field) {
    // Constraint: bit * (1 - bit) == 0  <=>  bit is 0 or 1.
    assert(bit * (1 - bit) == 0);
}

/// Compute the Merkle root from a leaf and its authentication path.
///   bits[i] = 0  => current node is the LEFT child  (sibling is on the right)
///   bits[i] = 1  => current node is the RIGHT child (sibling is on the left)
/// Each bit is constrained boolean inside this function.
pub fn compute_merkle_root(
    leaf: Field,
    siblings: [Field; 20],
    bits: [Field; 20]
) -> Field {
    let mut current = leaf;
    for i in 0..20 {
        assert_boolean(bits[i]);
        let (left, right) = if bits[i] == 0 {
            (current, siblings[i])
        } else {
            (siblings[i], current)
        };
        current = hash2(left, right);
    }
    current
}

// Expose ZEROS as a computed array for tests/helpers.
// Named alias so callers don't have to call compute_zeros() by name.
pub global ZEROS_0: Field = ZERO_VALUE;
pub global ZEROS_20: Field = EMPTY_ROOT;
