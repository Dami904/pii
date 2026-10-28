// pii_lib — public API
// Re-export every symbol circuits need to import.

pub mod poseidon;
pub mod keys;
pub mod notes;
pub mod orders;
pub mod merkle;
pub mod math;
pub mod test_helpers;

// ── Flat re-exports for convenience ──────────────────────────────────────────

pub use poseidon::{poseidon2_hash, hash2, hash3, hash4, hash8};
pub use keys::{owner_key, note_secret};
pub use notes::{ZERO_VALUE, note_commitment, nullifier, output_commitment};
pub use orders::{USDC_ADDRESS, usdc_asset_id, asset_id, order_commitment, eligibility_leaf};
pub use merkle::{TREE_DEPTH, EMPTY_ROOT, ZEROS_0, ZEROS_20, assert_boolean, compute_merkle_root, compute_zeros};
pub use math::{assert_64, geq64, min64, midpoint, mul_div_price};

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────
//
// Every golden value is from SPEC §2.  A mismatch is a hard blocker.

#[test]
fn test_hash2_1_2() {
    assert(hash2(1, 2) == 0x038682aa1cb5ae4e0a3f13da432a95c77c5c111f6f030faf9cad641ce1ed7383);
}

#[test]
fn test_hash2_0_0() {
    assert(hash2(0, 0) == 0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1);
}

#[test]
fn test_hash3_1_2_3() {
    assert(hash3(1, 2, 3) == 0x23864adb160dddf590f1d3303683ebcb914f828e2635f6e85a32f0a1aecd3dd8);
}

#[test]
fn test_hash4_1_2_3_4() {
    assert(hash4(1, 2, 3, 4) == 0x130bf204a32cac1f0ace56c78b731aa3809f06df2731ebcf6b3464a15788b1b9);
}

#[test]
fn test_hash8_1_to_8() {
    assert(hash8(1, 2, 3, 4, 5, 6, 7, 8) == 0x01dec21c6e1b30609eda618d7e35e5d9d6152f8fa67320d939c1a89603647142);
}

#[test]
fn test_ZERO_VALUE() {
    // keccak256("pii-shielded-pool-v1") mod r  (precomputed, matches Solidity)
    assert(ZERO_VALUE == 0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466);
}

#[test]
fn test_empty_root() {
    let zeros = compute_zeros();
    assert(zeros[20] == 0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7);
    // Also check the global alias
    assert(EMPTY_ROOT == 0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7);
}

#[test]
fn test_zeros_0_eq_ZERO_VALUE() {
    let zeros = compute_zeros();
    assert(zeros[0] == ZERO_VALUE);
    assert(ZEROS_0 == ZERO_VALUE);
}

#[test]
fn test_owner_key_7() {
    assert(owner_key(7) == 0x0b0f697117aa52458ddd243aeeac42e2a58175474f8889f3d763521eea2ce64b);
}

#[test]
fn test_note_commitment_golden() {
    // SPEC §2: hash3(5, 1000, hash2(owner_key(7), 999))
    let ok = owner_key(7);
    let secret = note_secret(ok, 999);
    let cmt = note_commitment(5, 1000, secret);
    assert(cmt == 0x0c91a967c6efc9312a70afc4e9da7a96849449459ab6e1e9f023162a0ee5f360);
}

#[test]
fn test_nullifier_golden() {
    // SPEC §2: hash2(commitment, sk=7)
    let ok = owner_key(7);
    let secret = note_secret(ok, 999);
    let cmt = note_commitment(5, 1000, secret);
    let nf = nullifier(cmt, 7);
    assert(nf == 0x1153d7217f751902fd027cab215bcc2ee93bec902ee4e0f557a7e5cbaab99788);
}

#[test]
fn test_order_commitment_golden() {
    // SPEC §2: hash8(0, 2e7, 10, 5, 6, owner_key(7), 42, 1800000000)
    let ok = owner_key(7);
    let oc = order_commitment(0, 20_000_000, 10, 5, 6, ok, 42, 1_800_000_000);
    assert(oc == 0x2e41f6b075f636c0b7ac654984c605f2b6119c600c1aacffc96f7b49c760ec42);
}

#[test]
fn test_output_commitment_zero_amount_gives_ZERO_VALUE() {
    // amount = 0 => sentinel
    let sentinel = output_commitment(5, 0, 999);
    assert(sentinel == ZERO_VALUE);
}

#[test]
fn test_output_commitment_nonzero_amount() {
    let ok = owner_key(7);
    let secret = note_secret(ok, 999);
    let direct = note_commitment(5, 1000, secret);
    let via_output = output_commitment(5, 1000, secret);
    assert(direct == via_output);
}

#[test]
fn test_assert_boolean_pass_0() {
    assert_boolean(0);
}

#[test]
fn test_assert_boolean_pass_1() {
    assert_boolean(1);
}

#[test(should_fail)]
fn test_assert_boolean_fail_2() {
    assert_boolean(2);
}

#[test]
fn test_compute_merkle_root_single_leaf() {
    // Insert one leaf at index 0.
    // At each level, bit=0 (left child), sibling = zeros[i].
    let leaf = hash2(42, 0); // arbitrary leaf
    let zeros = compute_zeros();

    let mut siblings: [Field; 20] = [0; 20];
    for i in 0..20 {
        siblings[i] = zeros[i];
    }
    let bits: [Field; 20] = [0; 20];

    let root = compute_merkle_root(leaf, siblings, bits);

    // Compute expected root by hand: start from leaf, hash with zeros[i] at each level
    let mut expected = leaf;
    for i in 0..20 {
        expected = hash2(expected, zeros[i]);
    }
    assert(root == expected);
}

#[test]
fn test_path_for_single_leaf_root_matches() {
    // Insert leaf at index 0.  path_for returns the siblings and bits.
    // compute_merkle_root(leaf, siblings, bits) must equal path_for's root.
    let leaf: Field = 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef;
    let prev_leaves: [Field; 64] = [0; 64]; // no prior leaves

    let (siblings, bits, path_root) = test_helpers::path_for(prev_leaves, 0, leaf);
    let recomputed_root = compute_merkle_root(leaf, siblings, bits);

    assert(recomputed_root == path_root);
}

#[test]
fn test_path_for_second_leaf_root_matches() {
    // Insert two leaves: leaf0 at index 0, leaf1 at index 1.
    // path_for(prev=[leaf0, 0, ...], 1, leaf1) root must equal compute_merkle_root.
    let leaf0: Field = 0x111;
    let leaf1: Field = 0x222;
    let mut prev_leaves: [Field; 64] = [0; 64];
    prev_leaves[0] = leaf0;

    let (siblings, bits, path_root) = test_helpers::path_for(prev_leaves, 1, leaf1);
    let recomputed_root = compute_merkle_root(leaf1, siblings, bits);

    assert(recomputed_root == path_root);
}

#[test]
fn test_assert_64_pass() {
    assert_64(0xffffffffffffffff); // max u64
}

#[test(should_fail)]
fn test_assert_64_fail() {
    assert_64(0x10000000000000000); // 2^64 — should fail
}

#[test]
fn test_midpoint() {
    assert(midpoint(10, 20) == 15);
    assert(midpoint(1, 2) == 1); // floor((1+2)/2) = 1
    assert(midpoint(0, 0) == 0);
}

#[test]
fn test_min64() {
    assert(min64(3, 7) == 3);
    assert(min64(7, 3) == 3);
    assert(min64(5, 5) == 5);
}

#[test]
fn test_geq64() {
    assert(geq64(5, 3) == true);
    assert(geq64(3, 5) == false);
    assert(geq64(5, 5) == true);
}

#[test]
fn test_eligibility_leaf() {
    // eligibility_leaf(asset_id, owner_key) = hash2(asset_id, owner_key)
    let aid: Field = 5;
    let ok = owner_key(7);
    let leaf = eligibility_leaf(aid, ok);
    assert(leaf == hash2(aid, ok));
}
