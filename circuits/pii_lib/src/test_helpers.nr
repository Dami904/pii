// Test-only helpers.
//
// path_for(prev_leaves, idx, leaf) builds the exact authentication path that
// PiiMerkle._insert would produce for `leaf` at position `idx`, given that
// `prev_leaves` (entries 0..idx-1) were inserted first.
//
// Returns (siblings[20], bits[20], root).
// The root is verified by: compute_merkle_root(leaf, siblings, bits) == root.
//
// Algorithm mirrors PiiMerkle._insert exactly:
//   filled_subtrees[i] = the last left-child hash recorded at depth i.
//   zeros[i]           = ZERO_VALUE-based empty subtree at depth i.
//   bit[i] = (leaf_index >> i) & 1.

use crate::poseidon::hash2;
use crate::merkle::compute_zeros;

/// Build the depth-20 authentication path for `leaf` at index `idx`.
/// `prev_leaves` is a [Field; 64] where slot j holds the leaf inserted at
/// index j, and unused slots are 0.  Pass prev_leaves[0..idx-1] populated.
pub fn path_for(prev_leaves: [Field; 64], idx: u32, leaf: Field) -> ([Field; 20], [Field; 20], Field) {
    let zeros = compute_zeros();
    let mut filled: [Field; 20] = [0; 20];
    // Initialise filled subtrees to the zero subtrees (same as PiiMerkle constructor)
    for i in 0..20 {
        filled[i] = zeros[i];
    }

    // Replay all previous insertions to build up the filled_subtrees state
    for j in 0..64 {
        let prev = prev_leaves[j];
        if prev != 0 {
            let mut current = prev;
            for i in 0..20 {
                let bit = (j >> i) & 1;
                // Save before potentially mutating
                let saved_filled_i = filled[i];
                let saved_zeros_i  = zeros[i];
                let (left, right) = if bit == 0 {
                    (current, saved_zeros_i)
                } else {
                    (saved_filled_i, current)
                };
                if bit == 0 {
                    filled[i] = current;
                }
                current = hash2(left, right);
            }
        }
    }

    // Build the authentication path for `leaf` at `idx`
    let mut siblings: [Field; 20] = [0; 20];
    let mut bits: [Field; 20] = [0; 20];
    let mut current = leaf;

    for i in 0..20 {
        let bit = (idx >> i) & 1;
        bits[i] = bit as Field;
        let saved_filled_i = filled[i];
        let saved_zeros_i  = zeros[i];
        let (left, right) = if bit == 0 {
            siblings[i] = saved_zeros_i;
            (current, saved_zeros_i)
        } else {
            siblings[i] = saved_filled_i;
            (saved_filled_i, current)
        };
        current = hash2(left, right);
    }

    (siblings, bits, current)
}
