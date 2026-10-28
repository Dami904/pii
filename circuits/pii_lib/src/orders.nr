// Order primitives and asset helpers (SPEC §2).
use crate::poseidon::{hash2, hash8};

// USDC on Arc Testnet: 0x3600000000000000000000000000000000000000
// asset_id(token) = hash2(uint160(token), 0)
pub global USDC_ADDRESS: Field = 0x3600000000000000000000000000000000000000;

/// usdc_asset_id() = hash2(USDC_ADDRESS, 0)
pub fn usdc_asset_id() -> Field {
    hash2(USDC_ADDRESS, 0)
}

/// asset_id for any EVM token address (uint160 fits in Field on BN254).
pub fn asset_id(token_address: Field) -> Field {
    hash2(token_address, 0)
}

/// order_commitment — SPEC §2 field order:
///   hash8(side, price, amount, asset_base, asset_quote, owner_key, nonce, expiry)
pub fn order_commitment(
    side: Field,
    price: Field,
    amount: Field,
    asset_base: Field,
    asset_quote: Field,
    owner_key: Field,
    nonce: Field,
    expiry: Field
) -> Field {
    hash8(side, price, amount, asset_base, asset_quote, owner_key, nonce, expiry)
}

/// eligibility_leaf(asset_id, owner_key) = hash2(asset_id, owner_key)
/// Used in v2 eligibility/KYC Merkle trees.
pub fn eligibility_leaf(a_id: Field, ok: Field) -> Field {
    hash2(a_id, ok)
}
