// Key derivation (SPEC §2).
use crate::poseidon::hash2;

/// owner_key(spending_key) = hash2(spending_key, 0)
/// The public key committed in notes; derived from the spending_key without revealing it.
pub fn owner_key(spending_key: Field) -> Field {
    hash2(spending_key, 0)
}

/// note_secret(owner_key, blinding) = hash2(owner_key, blinding)
/// The secret inside a note commitment. Hides both the owner and the blinding.
pub fn note_secret(ok: Field, blinding: Field) -> Field {
    hash2(ok, blinding)
}
