// Pii withdraw circuit — SPEC §4.1
//
// Public inputs (exact order): merkle_root, nullifier, recipient, amount,
//   change_commitment, ext_data_hash
// Private inputs: spending_key, note_amount, note_blinding,
//   merkle_siblings[20], merkle_bits[20], change_blinding

use pii_lib::hash2;
use pii_lib::compute_zeros;
use pii_lib::owner_key;
use pii_lib::note_secret;
use pii_lib::note_commitment;
use pii_lib::nullifier as pii_nullifier;
use pii_lib::usdc_asset_id;
use pii_lib::output_commitment;
use pii_lib::ZERO_VALUE;
use pii_lib::EMPTY_ROOT;
use pii_lib::compute_merkle_root;
use pii_lib::assert_64;

fn main(
    merkle_root:       pub Field,
    nullifier:         pub Field,
    recipient:         pub Field,
    amount:            pub Field,
    change_commitment: pub Field,
    ext_data_hash:     pub Field,

    spending_key:    Field,
    note_amount:     Field,
    note_blinding:   Field,
    merkle_siblings: [Field; 20],
    merkle_bits:     [Field; 20],
    change_blinding: Field,
) {
    // 1. Range-check amounts (before u64 casts)
    assert_64(note_amount);
    assert_64(amount);

    // 2. Rebuild input note (always USDC)
    let usdc_id = usdc_asset_id();
    let ok      = owner_key(spending_key);
    let secret  = note_secret(ok, note_blinding);
    let cmt     = note_commitment(usdc_id, note_amount, secret);

    // 3. Nullifier check
    assert(nullifier == pii_nullifier(cmt, spending_key), "nullifier mismatch");

    // 4. Merkle membership
    let computed_root = compute_merkle_root(cmt, merkle_siblings, merkle_bits);
    assert(merkle_root == computed_root, "note not in tree");

    // 5. Amount constraints
    assert(amount != 0, "amount is zero");
    let note_u: u64 = note_amount as u64;
    let amt_u: u64  = amount as u64;
    assert(amt_u <= note_u, "overdraw");

    // 6. Change output — same owner
    let change_amount: Field = (note_u - amt_u) as Field;
    let change_secret = note_secret(ok, change_blinding);
    assert(change_commitment == output_commitment(usdc_id, change_amount, change_secret), "change_commitment mismatch");

    // 7. Recipient is a valid Ethereum address
    assert(recipient != 0, "recipient is zero");
    recipient.assert_max_bit_size::<160>();

    // 8. ext_data_hash is bound by being a public input
    let _ = ext_data_hash;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

mod tests {
    use pii_lib::hash2;
    use pii_lib::compute_zeros;
    use pii_lib::owner_key;
    use pii_lib::note_secret;
    use pii_lib::note_commitment;
    use pii_lib::nullifier as pii_nullifier;
    use pii_lib::usdc_asset_id;
    use pii_lib::output_commitment;
    use pii_lib::ZERO_VALUE;
    use pii_lib::EMPTY_ROOT;

    fn make_1leaf_path(leaf: Field) -> ([Field; 20], [Field; 20], Field) {
        let zeros = compute_zeros();
        let mut sib: [Field; 20] = [0; 20];
        let bits: [Field; 20] = [0; 20];
        for i in 0..20 { sib[i] = zeros[i]; }
        let mut cur = leaf;
        for i in 0..20 { cur = hash2(cur, zeros[i]); }
        (sib, bits, cur)
    }

    fn make_2leaf_path(dummy: Field, leaf: Field) -> ([Field; 20], [Field; 20], Field) {
        let zeros = compute_zeros();
        let mut sib: [Field; 20] = [0; 20];
        let mut bits: [Field; 20] = [0; 20];
        sib[0] = dummy; bits[0] = 1;
        for i in 1..20 { sib[i] = zeros[i]; bits[i] = 0; }
        let mut cur = hash2(dummy, leaf);
        for i in 1..20 { cur = hash2(cur, zeros[i]); }
        (sib, bits, cur)
    }

    // ── Positive ──────────────────────────────────────────────────────────────

    #[test]
    fn test_partial_withdraw_with_change() {
        let sk: Field = 7;
        let uid = usdc_asset_id();
        let ok  = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let nf  = pii_nullifier(cmt, sk);
        let ch_amt: Field = (1000_u64 - 700_u64) as Field;
        let ch_cmt = output_commitment(uid, ch_amt, note_secret(ok, 111));
        let (sib, bits, root) = make_2leaf_path(0x1111, cmt);
        super::main(root, nf, 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    700, ch_cmt, 42, sk, 1000, 999, sib, bits, 111);
    }

    #[test]
    fn test_full_withdraw_change_is_sentinel() {
        let sk: Field = 7;
        let uid = usdc_asset_id();
        let ok  = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let nf  = pii_nullifier(cmt, sk);
        let (sib, bits, root) = make_1leaf_path(cmt);
        super::main(root, nf, 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    1000, ZERO_VALUE, 99, sk, 1000, 999, sib, bits, 0);
    }

    // ── Negative ──────────────────────────────────────────────────────────────

    #[test(should_fail_with = "overdraw")]
    fn test_fail_overdraw() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let (sib, bits, root) = make_1leaf_path(cmt);
        super::main(root, pii_nullifier(cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    1001, ZERO_VALUE, 0, sk, 1000, 999, sib, bits, 0);
    }

    #[test(should_fail_with = "change_commitment mismatch")]
    fn test_fail_inflated_change() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let bad_cmt = note_commitment(uid, 400, note_secret(ok, 111));
        let (sib, bits, root) = make_1leaf_path(cmt);
        super::main(root, pii_nullifier(cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    700, bad_cmt, 0, sk, 1000, 999, sib, bits, 111);
    }

    #[test(should_fail_with = "change_commitment mismatch")]
    fn test_fail_change_to_different_owner() {
        let sk: Field = 7; let other_sk: Field = 8;
        let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let bad = note_commitment(uid, 300, note_secret(owner_key(other_sk), 111));
        let (sib, bits, root) = make_1leaf_path(cmt);
        super::main(root, pii_nullifier(cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    700, bad, 0, sk, 1000, 999, sib, bits, 111);
    }

    #[test(should_fail_with = "change_commitment mismatch")]
    fn test_fail_sentinel_while_change_nonzero() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let (sib, bits, root) = make_1leaf_path(cmt);
        super::main(root, pii_nullifier(cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    700, ZERO_VALUE, 0, sk, 1000, 999, sib, bits, 0);
    }

    #[test(should_fail_with = "note not in tree")]
    fn test_fail_wrong_spending_key() {
        // Circuit uses wrong_sk → rebuilds wrong_ok → different cmt_rebuilt.
        // We supply nullifier = pii_nullifier(cmt_rebuilt, wrong_sk) so the nullifier
        // check passes; but cmt_rebuilt is NOT in the tree (tree has cmt with ok), so
        // the Merkle check fires "note not in tree".
        let sk: Field = 7; let wrong_sk: Field = 99;
        let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let wrong_ok = owner_key(wrong_sk);
        let cmt_rebuilt = note_commitment(uid, 1000, note_secret(wrong_ok, 999));
        let ch_cmt      = note_commitment(uid, 500, note_secret(wrong_ok, 222));
        // Tree is built around the real cmt; siblings from that tree
        let (sib, bits, root) = make_1leaf_path(cmt);
        // nullifier = pii_nullifier(cmt_rebuilt, wrong_sk) passes the circuit's nullifier check
        super::main(root, pii_nullifier(cmt_rebuilt, wrong_sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    500, ch_cmt, 0, wrong_sk, 1000, 999, sib, bits, 222);
    }

    #[test(should_fail_with = "note not in tree")]
    fn test_fail_note_not_in_tree() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let ch_cmt = note_commitment(uid, 500, note_secret(ok, 222));
        let zeros = compute_zeros();
        let mut sib: [Field; 20] = [0; 20]; let bits: [Field; 20] = [0; 20];
        for i in 0..20 { sib[i] = zeros[i]; }
        super::main(EMPTY_ROOT, pii_nullifier(cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    500, ch_cmt, 0, sk, 1000, 999, sib, bits, 222);
    }

    #[test(should_fail_with = "note not in tree")]
    fn test_fail_share_note() {
        // Tree contains a share note; circuit always rebuilds with usdc_id.
        // Supply nullifier = pii_nullifier(uid_cmt, sk) so nullifier check passes;
        // uid_cmt is NOT in the tree (tree has share_cmt), so "note not in tree" fires.
        let sk: Field = 7; let share_id: Field = 5;
        let uid = usdc_asset_id(); let ok = owner_key(sk);
        let share_cmt = note_commitment(share_id, 1000, note_secret(ok, 999));
        // uid_cmt is what the circuit rebuilds (using usdc_id, not share_id)
        let uid_cmt   = note_commitment(uid, 1000, note_secret(ok, 999));
        let ch_cmt    = note_commitment(uid, 500, note_secret(ok, 222));
        // Tree is built around share_cmt; uid_cmt won't verify against this root
        let (sib, bits, root) = make_1leaf_path(share_cmt);
        // Supply nullifier consistent with what the circuit computes (uid_cmt, sk)
        super::main(root, pii_nullifier(uid_cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    500, ch_cmt, 0, sk, 1000, 999, sib, bits, 222);
    }

    #[test(should_fail_with = "amount is zero")]
    fn test_fail_zero_amount() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let ch_cmt = note_commitment(uid, 1000, note_secret(ok, 222));
        let (sib, bits, root) = make_1leaf_path(cmt);
        super::main(root, pii_nullifier(cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    0, ch_cmt, 0, sk, 1000, 999, sib, bits, 222);
    }

    // ── NEW mutation-kill tests ────────────────────────────────────────────────

    // Guard: nullifier == pii_nullifier(cmt, spending_key)
    // Wrong public nullifier with a valid note and valid key.
    #[test(should_fail_with = "nullifier mismatch")]
    fn test_fail_wrong_public_nullifier() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let (sib, bits, root) = make_1leaf_path(cmt);
        let wrong_nf: Field = 0x1234; // arbitrary wrong nullifier
        super::main(root, wrong_nf,
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    700, ZERO_VALUE, 0, sk, 1000, 999, sib, bits, 0);
    }

    // Guard: assert_64(note_amount) — note_amount >= 2^64 wraps and fails range check.
    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_fail_note_amount_overflow() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        // note_amount = 2^64 — exceeds 64-bit range check
        let huge: Field = 18446744073709551616; // 2^64
        // We just need the circuit to reject the range check; tree path is irrelevant.
        let zeros = compute_zeros();
        let mut sib: [Field; 20] = [0; 20];
        let bits: [Field; 20] = [0; 20];
        for i in 0..20 { sib[i] = zeros[i]; }
        let cmt = note_commitment(uid, huge, note_secret(ok, 999));
        let root = {
            let mut c = cmt;
            for i in 0..20 { c = hash2(c, zeros[i]); }
            c
        };
        super::main(root, pii_nullifier(cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    huge, ZERO_VALUE, 0, sk, huge, 999, sib, bits, 0);
    }

    // Guard: assert_64(amount) — public withdraw amount >= 2^64.
    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_fail_amount_overflow() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let (sib, bits, root) = make_1leaf_path(cmt);
        let huge: Field = 18446744073709551616; // 2^64
        // change_commitment doesn't matter — range check fires first
        super::main(root, pii_nullifier(cmt, sk),
                    0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef,
                    huge, ZERO_VALUE, 0, sk, 1000, 999, sib, bits, 0);
    }

    // Guard: assert(recipient != 0) — recipient is the zero address.
    #[test(should_fail_with = "recipient is zero")]
    fn test_fail_recipient_zero() {
        let sk: Field = 7; let uid = usdc_asset_id(); let ok = owner_key(sk);
        let cmt = note_commitment(uid, 1000, note_secret(ok, 999));
        let (sib, bits, root) = make_1leaf_path(cmt);
        super::main(root, pii_nullifier(cmt, sk),
                    0, // recipient == 0
                    1000, ZERO_VALUE, 0, sk, 1000, 999, sib, bits, 0);
    }
}
