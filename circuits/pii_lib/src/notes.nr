// Note primitives (SPEC §2).
use crate::poseidon::{hash2, hash3};

// ZERO_VALUE = keccak256("pii-shielded-pool-v1") mod r
// This is the empty-leaf sentinel AND the "no output" sentinel.
// Precomputed — verified in golden-vector tests.
pub global ZERO_VALUE: Field =
    0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466;

/// note_commitment(asset_id, amount, secret) = hash3(asset_id, amount, secret)
///   where secret = note_secret(owner_key, blinding) = hash2(owner_key, blinding).
pub fn note_commitment(asset_id: Field, amount: Field, secret: Field) -> Field {
    hash3(asset_id, amount, secret)
}

/// nullifier(commitment, spending_key) = hash2(commitment, spending_key)
pub fn nullifier(commitment: Field, spending_key: Field) -> Field {
    hash2(commitment, spending_key)
}

/// output_commitment — if amount is 0, the output is the ZERO_VALUE sentinel
/// (PiiPool will skip inserting it).  Otherwise compute the real commitment.
pub fn output_commitment(asset_id: Field, amount: Field, secret: Field) -> Field {
    if amount == 0 {
        ZERO_VALUE
    } else {
        note_commitment(asset_id, amount, secret)
    }
}
