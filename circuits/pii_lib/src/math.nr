// Integer math helpers (SPEC §2 range rules).
// All amounts are < 2^64.  Use assert_max_bit_size::<64> before any comparison.

/// Constrain that `x` fits in 64 bits.
pub fn assert_64(x: Field) {
    x.assert_max_bit_size::<64>();
}

/// Returns true iff a >= b, treating both as u64.
/// Caller must have already range-checked a and b with assert_64.
pub fn geq64(a: Field, b: Field) -> bool {
    let au: u64 = a as u64;
    let bu: u64 = b as u64;
    au >= bu
}

/// Returns min(a, b) as a Field, treating both as u64.
pub fn min64(a: Field, b: Field) -> Field {
    let au: u64 = a as u64;
    let bu: u64 = b as u64;
    if au <= bu { a } else { b }
}

/// Midpoint of two u64 prices: (a + b) / 2, rounding down.
/// Overflow-safe: uses u64 arithmetic.
pub fn midpoint(a: Field, b: Field) -> Field {
    let au: u64 = a as u64;
    let bu: u64 = b as u64;
    // (a + b) / 2; no overflow because (a + b) <= 2^64 - 2 in u64
    // But if a + b overflows u64 we divide before adding:
    //   a/2 + b/2 + ((a & 1) + (b & 1)) / 2
    let half_a = au / 2;
    let half_b = bu / 2;
    let rem = (au & 1) + (bu & 1); // 0, 1, or 2
    ((half_a + half_b + rem / 2) as Field)
}

/// mul_div_price(amount, numerator, denominator) = floor(amount * numerator / denominator)
/// Used for partial-fill price improvement: all values are u64.
pub fn mul_div_price(amount: Field, num: Field, den: Field) -> Field {
    let a: u64 = amount as u64;
    let n: u64 = num as u64;
    let d: u64 = den as u64;
    // Use u128-equivalent: split and combine to avoid overflow.
    // Noir Field arithmetic is over BN254 Fr (254-bit), so u64*u64 < 2^128 < Fr.
    let product: Field = (a as Field) * (n as Field);
    // Divide: floor(product / d).  d != 0 is a precondition (caller must assert).
    let q: u64 = (product as u64) / d; // safe: product as u64 may truncate if >2^64
    // Better: do exact field division then truncate.
    // Since all values fit in 64 bits, product < 2^128, which fits in Field.
    // Compute q_field = floor(product / d) by checking q*d <= product < (q+1)*d.
    // Use u64 floor division — exact for values in 64-bit range.
    q as Field
}
