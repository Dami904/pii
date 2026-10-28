// Pii transfer circuit — SPEC §4.2
//
// Public inputs (exact order):
//   merkle_root, nf_0, nf_1, nf_fee,
//   out_recipient, out_change, out_fee, out_fee_change,
//   eligibility_root, fee, relayer_owner_key, ext_data_hash
// Private inputs:
//   asset, in_amount[2], in_sk[2], in_blinding[2],
//   in_siblings[2][20], in_bits[2][20],
//   fee_amount_in, fee_sk, fee_blinding_in,
//   fee_siblings[20], fee_bits[20],
//   send_amount, recipient_owner, recipient_blinding,
//   change_blinding, fee_out_blinding, fee_change_blinding,
//   elig_siblings[20], elig_bits[20]

use pii_lib::owner_key;
use pii_lib::note_secret;
use pii_lib::note_commitment;
use pii_lib::nullifier as pii_nullifier;
use pii_lib::usdc_asset_id;
use pii_lib::output_commitment;
use pii_lib::compute_merkle_root;
use pii_lib::assert_64;
use pii_lib::eligibility_leaf;

fn main(
    // ── Public ────────────────────────────────────────────────────────────────
    merkle_root:       pub Field,
    nf_0:              pub Field,
    nf_1:              pub Field,
    nf_fee:            pub Field,
    out_recipient:     pub Field,
    out_change:        pub Field,
    out_fee:           pub Field,
    out_fee_change:    pub Field,
    eligibility_root:  pub Field,
    fee:               pub Field,
    relayer_owner_key: pub Field,
    ext_data_hash:     pub Field,

    // ── Private ───────────────────────────────────────────────────────────────
    asset:           Field,
    in_amount:       [Field; 2],
    in_sk:           [Field; 2],
    in_blinding:     [Field; 2],
    in_siblings_0:   [Field; 20],
    in_bits_0:       [Field; 20],
    in_siblings_1:   [Field; 20],
    in_bits_1:       [Field; 20],
    fee_amount_in:   Field,
    fee_sk:          Field,
    fee_blinding_in: Field,
    fee_siblings:    [Field; 20],
    fee_bits:        [Field; 20],
    send_amount:     Field,
    recipient_owner: Field,
    recipient_blinding: Field,
    change_blinding: Field,
    fee_out_blinding:   Field,
    fee_change_blinding: Field,
    elig_siblings:   [Field; 20],
    elig_bits:       [Field; 20],
) {
    let usdc_id = usdc_asset_id();

    // ── Range checks ──────────────────────────────────────────────────────────
    assert_64(in_amount[0]);
    assert_64(in_amount[1]);
    assert_64(fee_amount_in);
    assert_64(send_amount);
    assert_64(fee);

    // ── in[0] is always real ──────────────────────────────────────────────────
    assert(in_amount[0] != 0, "in[0] amount must be non-zero");

    // ── in[0] note ───────────────────────────────────────────────────────────
    let ok0    = owner_key(in_sk[0]);
    let sec0   = note_secret(ok0, in_blinding[0]);
    let cmt0   = note_commitment(asset, in_amount[0], sec0);
    assert(nf_0 == pii_nullifier(cmt0, in_sk[0]), "nf_0 mismatch");
    let root0  = compute_merkle_root(cmt0, in_siblings_0, in_bits_0);
    assert(merkle_root == root0, "in[0] not in tree");

    // ── in[1] note (phantom-capable) ─────────────────────────────────────────
    let ok1  = owner_key(in_sk[1]);
    let sec1 = note_secret(ok1, in_blinding[1]);
    let cmt1 = note_commitment(asset, in_amount[1], sec1);
    assert(nf_1 == pii_nullifier(cmt1, in_sk[1]), "nf_1 mismatch");
    // Only check Merkle membership when in[1] is non-phantom
    if in_amount[1] != 0 {
        let root1 = compute_merkle_root(cmt1, in_siblings_1, in_bits_1);
        assert(merkle_root == root1, "in[1] not in tree");
    }

    // ── fee_in note (phantom-capable, always USDC) ────────────────────────────
    let fee_ok  = owner_key(fee_sk);
    let fee_sec = note_secret(fee_ok, fee_blinding_in);
    let fee_cmt = note_commitment(usdc_id, fee_amount_in, fee_sec);
    assert(nf_fee == pii_nullifier(fee_cmt, fee_sk), "nf_fee mismatch");
    if fee_amount_in != 0 {
        let fee_root = compute_merkle_root(fee_cmt, fee_siblings, fee_bits);
        assert(merkle_root == fee_root, "fee_in not in tree");
    }

    // ── Nullifiers are pairwise distinct ──────────────────────────────────────
    assert(nf_0 != nf_1, "nf_0 == nf_1: same note used twice");
    assert(nf_0 != nf_fee, "nf_0 == nf_fee: same note used twice");
    assert(nf_1 != nf_fee, "nf_1 == nf_fee: same note used twice");

    // ── Asset balance (in0 + in1 = send + change) ─────────────────────────────
    let in_sum_u: u64 = (in_amount[0] as u64) + (in_amount[1] as u64);
    let send_u:   u64 = send_amount as u64;
    assert(send_u <= in_sum_u, "overspend");
    let change_u: u64 = in_sum_u - send_u;

    // ── USDC fee balance (fee_in = fee + fee_change) ──────────────────────────
    let fee_in_u:     u64 = fee_amount_in as u64;
    let fee_u:        u64 = fee as u64;
    assert(fee_u <= fee_in_u, "fee overspend");
    let fee_change_u: u64 = fee_in_u - fee_u;

    // ── Output commitments ───────────────────────────────────────────────────
    // Recipient output
    let recip_secret = note_secret(recipient_owner, recipient_blinding);
    assert(out_recipient == output_commitment(asset, send_amount, recip_secret),
           "out_recipient mismatch");

    // Change output (back to in[0]'s owner)
    let change_secret = note_secret(ok0, change_blinding);
    assert(out_change == output_commitment(asset, change_u as Field, change_secret),
           "out_change mismatch");

    // Fee output (to relayer's owner_key)
    let fee_out_secret = note_secret(relayer_owner_key, fee_out_blinding);
    assert(out_fee == output_commitment(usdc_id, fee as Field, fee_out_secret),
           "out_fee mismatch");

    // Fee change output (back to fee_in's owner)
    let fee_change_secret = note_secret(fee_ok, fee_change_blinding);
    assert(out_fee_change == output_commitment(usdc_id, fee_change_u as Field, fee_change_secret),
           "out_fee_change mismatch");

    // ── Eligibility check (shares only, non-zero send) ────────────────────────
    if (asset != usdc_id) & (send_amount != 0) {
        let elig_leaf  = eligibility_leaf(asset, recipient_owner);
        let elig_root  = compute_merkle_root(elig_leaf, elig_siblings, elig_bits);
        assert(eligibility_root == elig_root, "recipient not eligible for asset");
    }

    // ── ext_data_hash bound by being a public input ───────────────────────────
    let _ = ext_data_hash;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

mod tests {
    use pii_lib::owner_key;
    use pii_lib::note_secret;
    use pii_lib::note_commitment;
    use pii_lib::nullifier as pii_nullifier;
    use pii_lib::usdc_asset_id;
    use pii_lib::output_commitment;
    use pii_lib::ZERO_VALUE;
    use pii_lib::compute_zeros;
    use pii_lib::eligibility_leaf;
    use pii_lib::hash2;
    use pii_lib::test_helpers::path_for;

    // ── Helpers ──────────────────────────────────────────────────────────────

    // Zero-filled siblings + bits for a phantom note's unused Merkle check
    fn zero_path() -> ([Field; 20], [Field; 20]) {
        let zeros = compute_zeros();
        let mut sib: [Field; 20] = [0; 20];
        let bits: [Field; 20]    = [0; 20];
        for i in 0..20 { sib[i] = zeros[i]; }
        (sib, bits)
    }

    // Empty prev_leaves array
    fn no_prev() -> [Field; 64] { [0; 64] }

    // prev_leaves with one entry at slot j
    fn prev1(j: Field, v: Field) -> [Field; 64] {
        let mut p: [Field; 64] = [0; 64];
        for k in 0..64 { if k as Field == j { p[k] = v; } }
        p
    }

    // Build authentication paths for three leaves against their COMMON final root.
    // Leaves are inserted in order l0@0, l1@1, l2@2.  Returns
    //   (sib0, bits0, sib1, bits1, sib2, bits2, root).
    // All three paths verify against the same `root`.
    fn paths_3leaf(l0: Field, l1: Field, l2: Field)
        -> ([Field; 20], [Field; 20],
            [Field; 20], [Field; 20],
            [Field; 20], [Field; 20],
            Field)
    {
        let zeros = compute_zeros();
        // Level-0 pairs
        let p01 = hash2(l0, l1);           // pair (0,1): level 0
        let p23 = hash2(l2, zeros[0]);     // pair (2, zeros[0]): level 0
        let p0123 = hash2(p01, p23);       // quad (0..3): level 1
        // Final root: p0123 at level 1, hashed up with zeros[2..19]
        let mut root = p0123;
        for i in 2..20 { root = hash2(root, zeros[i]); }

        // Path for l0 at index 0 (bit pattern: all 0s)
        let mut sib0: [Field; 20] = [0; 20]; let mut bits0: [Field; 20] = [0; 20];
        sib0[0] = l1; bits0[0] = 0;         // sibling = l1 (right), we are left
        sib0[1] = p23; bits0[1] = 0;        // sibling = p23 (right), we are left
        for i in 2..20 { sib0[i] = zeros[i]; bits0[i] = 0; }

        // Path for l1 at index 1 (bit 0 = 1, rest 0)
        let mut sib1: [Field; 20] = [0; 20]; let mut bits1: [Field; 20] = [0; 20];
        sib1[0] = l0; bits1[0] = 1;         // sibling = l0 (left), we are right
        sib1[1] = p23; bits1[1] = 0;
        for i in 2..20 { sib1[i] = zeros[i]; bits1[i] = 0; }

        // Path for l2 at index 2 (bit 1 = 1, bit 0 = 0, rest 0)
        let mut sib2: [Field; 20] = [0; 20]; let mut bits2: [Field; 20] = [0; 20];
        sib2[0] = zeros[0]; bits2[0] = 0;   // sibling = zeros[0], we are left in pair(2,z)
        sib2[1] = p01; bits2[1] = 1;        // sibling = p01, we are right in quad
        for i in 2..20 { sib2[i] = zeros[i]; bits2[i] = 0; }

        (sib0, bits0, sib1, bits1, sib2, bits2, root)
    }

    // Build authentication paths for two leaves against their COMMON final root.
    fn paths_2leaf(l0: Field, l1: Field)
        -> ([Field; 20], [Field; 20],
            [Field; 20], [Field; 20],
            Field)
    {
        let zeros = compute_zeros();
        let p01 = hash2(l0, l1);
        let mut root = p01;
        for i in 1..20 { root = hash2(root, zeros[i]); }

        let mut sib0: [Field; 20] = [0; 20]; let mut bits0: [Field; 20] = [0; 20];
        sib0[0] = l1; bits0[0] = 0;
        for i in 1..20 { sib0[i] = zeros[i]; bits0[i] = 0; }

        let mut sib1: [Field; 20] = [0; 20]; let mut bits1: [Field; 20] = [0; 20];
        sib1[0] = l0; bits1[0] = 1;
        for i in 1..20 { sib1[i] = zeros[i]; bits1[i] = 0; }

        (sib0, bits0, sib1, bits1, root)
    }

    // ── Positive test 1: USDC transfer with fee ───────────────────────────────
    #[test]
    fn test_usdc_transfer_with_fee() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let sk1 = 8; let ok1 = owner_key(sk1);
        let cmt1 = note_commitment(uid, 400, note_secret(ok1, 200));
        let fee_sk = 9; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 50, note_secret(fee_ok, 300));

        // All 3 notes in the same tree; all paths verify against the same root
        let (sib0, bits0, sib1, bits1, sfee, bfee, root) =
            paths_3leaf(cmt0, cmt1, fee_cmt);

        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(cmt1, sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);

        let send_u: u64    = 700;
        let fee_val: u64   = 20;
        let change_u: u64  = (600 + 400) - send_u;  // 300
        let fee_ch_u: u64  = 50 - fee_val;           // 30

        let recip_owner = owner_key(42);
        let relayer_ok  = owner_key(99);

        let out_recip  = output_commitment(uid, send_u as Field,   note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, change_u as Field,  note_secret(ok0, 501));
        let out_fee    = output_commitment(uid, fee_val as Field,   note_secret(relayer_ok, 502));
        let out_fch    = output_commitment(uid, fee_ch_u as Field,  note_secret(fee_ok, 503));

        let zeros = compute_zeros();
        let elig_root = zeros[20];
        let (esib, ebits) = zero_path();

        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, out_fee, out_fch,
            elig_root, fee_val as Field, relayer_ok, 0,
            uid,
            [600, 400], [sk0, sk1], [100, 200],
            sib0, bits0, sib1, bits1,
            50, fee_sk, 300, sfee, bfee,
            send_u as Field, recip_owner, 500,
            501, 502, 503,
            esib, ebits
        );
    }

    // ── Positive test 2: transfer with no fee ────────────────────────────────
    #[test]
    fn test_transfer_no_fee() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 1000, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);

        // phantom in[1]: amount=0, sk=11
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        // phantom fee_in: amount=0, sk=12
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));

        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);

        let recip_owner = owner_key(42);
        let relayer_ok  = owner_key(99);
        let out_recip  = output_commitment(uid, 600, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 400, note_secret(ok0, 501));

        let zeros = compute_zeros();
        let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let (psib, pbits) = zero_path();

        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid,
            [1000, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            600, recip_owner, 500,
            501, 502, 503,
            esib, ebits
        );
    }

    // ── Positive test 3: share transfer to eligible recipient ─────────────────
    #[test]
    fn test_share_transfer_eligible_recipient() {
        let uid = usdc_asset_id();
        let share_id: Field = hash2(0x1234567890abcdef, 0);

        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(share_id, 100, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);

        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(share_id, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));

        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);

        let recip_owner = owner_key(42);
        let relayer_ok  = owner_key(99);
        let out_recip  = output_commitment(share_id, 60, note_secret(recip_owner, 500));
        let out_change = output_commitment(share_id, 40, note_secret(ok0, 501));

        // Eligibility tree: single leaf for (share_id, recip_owner)
        let elig_leaf_val = eligibility_leaf(share_id, recip_owner);
        let (esib, ebits, elig_root) = path_for(no_prev(), 0, elig_leaf_val);
        let (psib, pbits) = zero_path();

        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            share_id,
            [100, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            60, recip_owner, 500,
            501, 502, 503,
            esib, ebits
        );
    }

    // ── Negative: ineligible share recipient ─────────────────────────────────
    #[test(should_fail_with = "recipient not eligible for asset")]
    fn test_fail_ineligible_share_recipient() {
        let uid = usdc_asset_id();
        let share_id: Field = hash2(0x1234567890abcdef, 0);
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(share_id, 100, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(share_id, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);

        let wrong_recip = owner_key(999);
        let relayer_ok  = owner_key(99);
        let out_recip  = output_commitment(share_id, 60, note_secret(wrong_recip, 500));
        let out_change = output_commitment(share_id, 40, note_secret(ok0, 501));

        // Elig tree has a DIFFERENT owner; wrong_recip's path won't match elig_root
        let good_owner   = owner_key(42);
        let elig_leaf_val = eligibility_leaf(share_id, good_owner);
        let (esib, ebits, elig_root) = path_for(no_prev(), 0, elig_leaf_val);
        let (psib, pbits) = zero_path();

        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            share_id,
            [100, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            60, wrong_recip, 500,
            501, 502, 503,
            esib, ebits  // path built for good_owner, not wrong_recip
        );
    }

    // ── Negative: overspend ──────────────────────────────────────────────────
    #[test(should_fail_with = "overspend")]
    fn test_fail_overspend() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42);
        let relayer_ok  = owner_key(99);
        // Send 700 from 600 => overspend
        let out_recip  = output_commitment(uid, 700, note_secret(recip_owner, 500));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, ZERO_VALUE, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            700, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // ── Negative: fee overspend ───────────────────────────────────────────────
    #[test(should_fail_with = "fee overspend")]
    fn test_fail_fee_overspend() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 10, note_secret(fee_ok, 300));
        // Both real notes share the same 2-leaf root
        let (sib0, bits0, sfee, bfee, root) = paths_2leaf(cmt0, fee_cmt);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let relayer_ok = owner_key(99);
        let recip_owner = owner_key(42);
        let (psib, pbits) = zero_path();
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        // fee=50 but fee_amount_in=10 => overspend
        let out_recip  = output_commitment(uid, 300, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 300, note_secret(ok0, 501));
        let out_fee    = output_commitment(uid, 50, note_secret(relayer_ok, 502));
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, out_fee, ZERO_VALUE,
            elig_root, 50, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            10, fee_sk, 300, sfee, bfee,
            300, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // ── Negative: inflated recipient output ───────────────────────────────────
    #[test(should_fail_with = "out_recipient mismatch")]
    fn test_fail_inflated_output() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42);
        let relayer_ok  = owner_key(99);
        // out_recipient claims 700 but send_amount will be 600 => mismatch
        let out_recip = output_commitment(uid, 700, note_secret(recip_owner, 500));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, ZERO_VALUE, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            600, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // ── Negative: same note used twice (nf_0 == nf_1) ────────────────────────
    #[test(should_fail_with = "nf_0 == nf_1: same note used twice")]
    fn test_fail_same_note_twice() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = nf_0; // SAME nullifier
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42);
        let relayer_ok  = owner_key(99);
        let out_recip  = output_commitment(uid, 600, note_secret(recip_owner, 500));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, ZERO_VALUE, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [600, 600], [sk0, sk0], [100, 100],
            sib0, bits0, sib0, bits0,
            0, fee_sk, 0, psib, pbits,
            600, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // ── NEW mutation-kill tests ────────────────────────────────────────────────

    // Guard: assert(in_amount[0] != 0, "in[0] amount must be non-zero")
    #[test(should_fail_with = "in[0] amount must be non-zero")]
    fn test_fail_in0_amount_zero() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        // in[0] with amount=0 — sentinel note
        let cmt0 = note_commitment(uid, 0, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let nf_0 = pii_nullifier(cmt0, sk0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let out_recip = output_commitment(uid, 0, note_secret(recip_owner, 500));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, ZERO_VALUE, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [0, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            0, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(nf_0 == pii_nullifier(cmt0, in_sk[0]), "nf_0 mismatch")
    #[test(should_fail_with = "nf_0 mismatch")]
    fn test_fail_wrong_nf0() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let wrong_nf0: Field = 0xdead; // arbitrary wrong value
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let out_recip  = output_commitment(uid, 400, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 200, note_secret(ok0, 501));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, wrong_nf0, nf_1, nf_fee,
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            400, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(nf_1 == pii_nullifier(cmt1, in_sk[1]), "nf_1 mismatch")
    // in[1] is a real (non-phantom) note here.
    #[test(should_fail_with = "nf_1 mismatch")]
    fn test_fail_wrong_nf1() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 400, note_secret(ok0, 100));
        let sk1 = 8; let ok1 = owner_key(sk1);
        let cmt1 = note_commitment(uid, 200, note_secret(ok1, 200));
        let (sib0, bits0, sib1, bits1, root) = paths_2leaf(cmt0, cmt1);
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let wrong_nf1: Field = 0xbeef; // wrong
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let out_recip  = output_commitment(uid, 400, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 200, note_secret(ok0, 501));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, wrong_nf1, nf_fee,
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [400, 200], [sk0, sk1], [100, 200],
            sib0, bits0, sib1, bits1,
            0, fee_sk, 0, psib, pbits,
            400, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(merkle_root == root0, "in[0] not in tree")
    #[test(should_fail_with = "in[0] not in tree")]
    fn test_fail_in0_not_in_tree() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        // Path built for a DIFFERENT leaf — cmt0 won't verify against this root.
        let other = note_commitment(uid, 999, note_secret(ok0, 0));
        // paths_2leaf returns (sib_for_other, bits_for_other, sib_for_cmt0, bits_for_cmt0, root)
        let (sib_other, bits_other, _sib_cmt0, _bits_cmt0, root) = paths_2leaf(other, cmt0);
        // We pass sib_other/bits_other (path for `other`) but claim to prove `cmt0` is in tree.
        let nf_0 = pii_nullifier(cmt0, sk0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let out_recip  = output_commitment(uid, 400, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 200, note_secret(ok0, 501));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib_other, bits_other, psib, pbits, // wrong path (path for `other`, not `cmt0`)
            0, fee_sk, 0, psib, pbits,
            400, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(merkle_root == root1, "in[1] not in tree") — non-phantom in[1]
    #[test(should_fail_with = "in[1] not in tree")]
    fn test_fail_in1_not_in_tree() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 400, note_secret(ok0, 100));
        let sk1 = 8; let ok1 = owner_key(sk1);
        let cmt1 = note_commitment(uid, 200, note_secret(ok1, 200));
        // Build paths_2leaf so both are in the tree; then deliberately swap in[1]'s
        // path with in[0]'s path so cmt1 doesn't verify.
        let (sib0, bits0, sib1, bits1, root) = paths_2leaf(cmt0, cmt1);
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(cmt1, sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let out_recip  = output_commitment(uid, 400, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 200, note_secret(ok0, 501));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [400, 200], [sk0, sk1], [100, 200],
            sib0, bits0, sib0, bits0, // deliberately use in[0]'s path for in[1]
            0, fee_sk, 0, psib, pbits,
            400, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(merkle_root == fee_root, "fee_in not in tree") — non-phantom fee_in
    #[test(should_fail_with = "fee_in not in tree")]
    fn test_fail_fee_in_not_in_tree() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 50, note_secret(fee_ok, 300));
        let (sib0, bits0, sfee, bfee, root) = paths_2leaf(cmt0, fee_cmt);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let relayer_ok = owner_key(99); let recip_owner = owner_key(42);
        let (psib, pbits) = zero_path();
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let out_recip  = output_commitment(uid, 300, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 300, note_secret(ok0, 501));
        let out_fee    = output_commitment(uid, 20,  note_secret(relayer_ok, 502));
        let out_fch    = output_commitment(uid, 30,  note_secret(fee_ok, 503));
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, out_fee, out_fch,
            elig_root, 20, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            50, fee_sk, 300, sib0, bits0, // wrong path: use in[0]'s path for fee_in
            300, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(nf_0 != nf_fee, "nf_0 == nf_fee: same note used twice")
    #[test(should_fail_with = "nf_0 == nf_fee: same note used twice")]
    fn test_fail_nf0_eq_nf_fee() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let nf_0 = pii_nullifier(cmt0, sk0);
        // nf_fee == nf_0: same note
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let relayer_ok = owner_key(99); let recip_owner = owner_key(42);
        let (psib, pbits) = zero_path();
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let out_recip  = output_commitment(uid, 300, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 300, note_secret(ok0, 501));
        // fee_in uses the SAME sk/blinding as in[0], so nf_fee == nf_0
        super::main(
            root, nf_0, nf_1, nf_0, // nf_fee = nf_0
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            600, sk0, 100, sib0, bits0, // fee_in == in[0] (same sk, blinding)
            300, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(nf_1 != nf_fee, "nf_1 == nf_fee: same note used twice")
    // Uses a real in[1] and makes fee_in == in[1].
    #[test(should_fail_with = "nf_1 == nf_fee: same note used twice")]
    fn test_fail_nf1_eq_nf_fee() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 400, note_secret(ok0, 100));
        let sk1 = 8; let ok1 = owner_key(sk1);
        let cmt1 = note_commitment(uid, 200, note_secret(ok1, 200));
        let (sib0, bits0, sib1, bits1, root) = paths_2leaf(cmt0, cmt1);
        let nf_0 = pii_nullifier(cmt0, sk0);
        let nf_1 = pii_nullifier(cmt1, sk1);
        // nf_fee == nf_1
        let relayer_ok = owner_key(99); let recip_owner = owner_key(42);
        let (psib, pbits) = zero_path();
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let out_recip  = output_commitment(uid, 300, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 300, note_secret(ok0, 501));
        super::main(
            root, nf_0, nf_1, nf_1, // nf_fee = nf_1
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [400, 200], [sk0, sk1], [100, 200],
            sib0, bits0, sib1, bits1,
            200, sk1, 200, sib1, bits1, // fee_in == in[1]
            300, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(out_change == output_commitment(...), "out_change mismatch")
    #[test(should_fail_with = "out_change mismatch")]
    fn test_fail_wrong_out_change() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 1000, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let out_recip  = output_commitment(uid, 600, note_secret(recip_owner, 500));
        // Wrong out_change: claims 500 but change should be 400
        let wrong_out_change = output_commitment(uid, 500, note_secret(ok0, 501));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, wrong_out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [1000, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            600, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(out_fee == output_commitment(...), "out_fee mismatch")
    #[test(should_fail_with = "out_fee mismatch")]
    fn test_fail_wrong_out_fee() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 50, note_secret(fee_ok, 300));
        let (sib0, bits0, sfee, bfee, root) = paths_2leaf(cmt0, fee_cmt);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let relayer_ok = owner_key(99); let recip_owner = owner_key(42);
        let (psib, pbits) = zero_path();
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let out_recip  = output_commitment(uid, 300, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 300, note_secret(ok0, 501));
        // Wrong out_fee: correct fee is 20 but we claim 30
        let wrong_out_fee = output_commitment(uid, 30, note_secret(relayer_ok, 502));
        let out_fch    = output_commitment(uid, 30, note_secret(fee_ok, 503));
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, wrong_out_fee, out_fch,
            elig_root, 20, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            50, fee_sk, 300, sfee, bfee,
            300, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert(out_fee_change == output_commitment(...), "out_fee_change mismatch")
    #[test(should_fail_with = "out_fee_change mismatch")]
    fn test_fail_wrong_out_fee_change() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 50, note_secret(fee_ok, 300));
        let (sib0, bits0, sfee, bfee, root) = paths_2leaf(cmt0, fee_cmt);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let relayer_ok = owner_key(99); let recip_owner = owner_key(42);
        let (psib, pbits) = zero_path();
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let out_recip  = output_commitment(uid, 300, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 300, note_secret(ok0, 501));
        let out_fee    = output_commitment(uid, 20,  note_secret(relayer_ok, 502));
        // Wrong out_fee_change: correct is 30 but we claim 31
        let wrong_out_fch = output_commitment(uid, 31, note_secret(fee_ok, 503));
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, out_fee, wrong_out_fch,
            elig_root, 20, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            50, fee_sk, 300, sfee, bfee,
            300, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert_64(in_amount[0]) — in_amount[0] >= 2^64
    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_fail_in_amount0_overflow() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let huge: Field = 18446744073709551616; // 2^64
        // Range check fires before any tree/nullifier check
        let cmt0 = note_commitment(uid, huge, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let nf_0 = pii_nullifier(cmt0, sk0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let out_recip = output_commitment(uid, huge, note_secret(recip_owner, 500));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, ZERO_VALUE, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [huge, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            huge, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // Guard: assert_64(send_amount) — send_amount >= 2^64
    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_fail_send_amount_overflow() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let nf_0 = pii_nullifier(cmt0, sk0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let huge: Field = 18446744073709551616; // 2^64
        let out_recip = output_commitment(uid, huge, note_secret(recip_owner, 500));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, ZERO_VALUE, ZERO_VALUE, ZERO_VALUE,
            elig_root, 0, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            huge, recip_owner, 500, 501, 502, 503, esib, ebits // send_amount=huge
        );
    }

    // Guard: assert_64(fee) — fee >= 2^64
    #[test(should_fail_with = "call to assert_max_bit_size")]
    fn test_fail_fee_overflow() {
        let uid = usdc_asset_id();
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);
        let nf_0 = pii_nullifier(cmt0, sk0);
        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt = note_commitment(uid, 0, note_secret(fee_ok, 0));
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        let nf_fee = pii_nullifier(fee_cmt, fee_sk);
        let recip_owner = owner_key(42); let relayer_ok = owner_key(99);
        let huge: Field = 18446744073709551616; // 2^64
        let out_recip  = output_commitment(uid, 300, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 300, note_secret(ok0, 501));
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path(); let (psib, pbits) = zero_path();
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, ZERO_VALUE, ZERO_VALUE,
            elig_root, huge, relayer_ok, 0, // fee=huge
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            0, fee_sk, 0, psib, pbits,
            300, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }

    // ── Negative: fee paid with a share note ─────────────────────────────────
    // The circuit always rebuilds fee_cmt with usdc_id; if the actual committed
    // note used share_id, the nf_fee check fires first: the circuit-computed
    // nullifier uses usdc_id and won't match the prover-supplied nf_fee.
    #[test(should_fail_with = "nf_fee mismatch")]
    fn test_fail_fee_with_share_note() {
        let uid = usdc_asset_id();
        let share_id: Field = hash2(0x1234567890abcdef, 0);
        let sk0 = 7; let ok0 = owner_key(sk0);
        let cmt0 = note_commitment(uid, 600, note_secret(ok0, 100));
        let (sib0, bits0, root) = path_for(no_prev(), 0, cmt0);

        // fee_in committed as a SHARE note — not in the USDC/share pool tree
        let fee_sk = 12; let fee_ok = owner_key(fee_sk);
        let fee_cmt_share = note_commitment(share_id, 50, note_secret(fee_ok, 300));
        // Its nullifier is computed by the prover using share_id, but the circuit
        // will rebuild with usdc_id and get a different nf — however we pass the
        // prover's nullifier, so nf_fee != circuit's nullifier => "nf_fee mismatch"
        // actually fires. Either message is correct. We use "fee_in not in tree"
        // because the Merkle path (path_for based on the same tree as cmt0) will
        // not contain fee_cmt_share.
        let (sfee, bfee, _) = path_for(prev1(0, cmt0), 1, fee_cmt_share);

        let ph_sk1 = 11; let ph_ok1 = owner_key(ph_sk1);
        let ph_cmt1 = note_commitment(uid, 0, note_secret(ph_ok1, 0));
        let nf_0   = pii_nullifier(cmt0, sk0);
        let nf_1   = pii_nullifier(ph_cmt1, ph_sk1);
        // Prover computes nullifier using share_id-committed note
        let nf_fee = pii_nullifier(fee_cmt_share, fee_sk);
        let relayer_ok  = owner_key(99);
        let recip_owner = owner_key(42);
        let zeros = compute_zeros(); let elig_root = zeros[20];
        let (esib, ebits) = zero_path();
        let (psib, pbits) = zero_path();
        let out_recip  = output_commitment(uid, 300, note_secret(recip_owner, 500));
        let out_change = output_commitment(uid, 300, note_secret(ok0, 501));
        let out_fee    = output_commitment(uid, 20,  note_secret(relayer_ok, 502));
        let out_fch    = output_commitment(uid, 30,  note_secret(fee_ok, 503));
        super::main(
            root, nf_0, nf_1, nf_fee,
            out_recip, out_change, out_fee, out_fch,
            elig_root, 20, relayer_ok, 0,
            uid, [600, 0], [sk0, ph_sk1], [100, 0],
            sib0, bits0, psib, pbits,
            50, fee_sk, 300, sfee, bfee,
            300, recip_owner, 500, 501, 502, 503, esib, ebits
        );
    }
}
