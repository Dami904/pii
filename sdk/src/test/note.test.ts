/**
 * sdk/src/test/note.test.ts
 * Tests that commitment() and nullifier() match the SPEC §2 golden values
 * from gen-e2e-fixture.ts.
 */

import { describe, test, expect } from "bun:test";
import { commitment, nullifier, depositSecret, randomBlinding, ZERO_VALUE } from "../note.js";
import { hash2 } from "../hash.js";
import type { Note } from "../note.js";

// ── Golden values from gen-e2e-fixture.ts (verified against forge tests) ──────

const USDC_ID   = BigInt("0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86e");
const OK_A      = hash2(7n, 0n);   // owner_key(sk=7)
const OK_B      = hash2(11n, 0n);  // owner_key(sk=11)

// leaf 0: sk=7 blinding=11 amount=2_000_000
const CMT_A0    = BigInt("0x25401d063ca1ea2e93b060c3191f5221a54f9d52fd5e8f81e666d9d07d6aa812");
const NF0       = BigInt("0x02b1971abd74524aa9b7175b7689356d5268d4c7bbcd59c57594577e7ca28bf4");

// leaf 1: sk=7 blinding=12 amount=1_000_000
const CMT_A1    = BigInt("0x291c073c82e06e7981a792ed4a700d1ab55853111cb1f4c20b5a69e67fdc7c86");
const NF1       = BigInt("0x21774fd5719064deb939a8266e597e385ea6a44be87f56350c00aafff704b637");

// leaf 3 (B's received note): owner_key(11), blinding=21, amount=2_500_000
const OUT_RECIP = BigInt("0x10c7132167488662b478551f5621750b5ac7154ae9d962a266dbede7681bc072");
const NFB       = BigInt("0x0d9ae79f04939e9a77ca1d0bde172b9f21e71ac5a780214b1d542861f4d4a2a0");

describe("note — commitment matches SPEC §2 golden values", () => {
  test("CMT_A0: sk=7 blinding=11 amount=2_000_000", () => {
    const note: Note = { assetId: USDC_ID, amount: 2_000_000n, ownerKey: OK_A, blinding: 11n };
    expect(commitment(note)).toBe(CMT_A0);
  });

  test("CMT_A1: sk=7 blinding=12 amount=1_000_000", () => {
    const note: Note = { assetId: USDC_ID, amount: 1_000_000n, ownerKey: OK_A, blinding: 12n };
    expect(commitment(note)).toBe(CMT_A1);
  });

  test("OUT_RECIP: sk=11 blinding=21 amount=2_500_000", () => {
    const note: Note = { assetId: USDC_ID, amount: 2_500_000n, ownerKey: OK_B, blinding: 21n };
    expect(commitment(note)).toBe(OUT_RECIP);
  });

  test("zero-amount note returns ZERO_VALUE", () => {
    const note: Note = { assetId: USDC_ID, amount: 0n, ownerKey: OK_A, blinding: 99n };
    expect(commitment(note)).toBe(ZERO_VALUE);
  });
});

describe("note — nullifier matches SPEC §2 golden values", () => {
  test("NF0: leaf0 sk=7", () => {
    const note: Note = { assetId: USDC_ID, amount: 2_000_000n, ownerKey: OK_A, blinding: 11n };
    expect(nullifier(note, 7n)).toBe(NF0);
  });

  test("NF1: leaf1 sk=7", () => {
    const note: Note = { assetId: USDC_ID, amount: 1_000_000n, ownerKey: OK_A, blinding: 12n };
    expect(nullifier(note, 7n)).toBe(NF1);
  });

  test("NFB: B's note sk=11", () => {
    const note: Note = { assetId: USDC_ID, amount: 2_500_000n, ownerKey: OK_B, blinding: 21n };
    expect(nullifier(note, 11n)).toBe(NFB);
  });
});

describe("note — depositSecret", () => {
  test("depositSecret(ownerKey, blinding) = hash2(ownerKey, blinding)", () => {
    expect(depositSecret(OK_A, 11n)).toBe(hash2(OK_A, 11n));
  });
});

describe("note — randomBlinding", () => {
  test("returns a positive bigint less than BN254_R", () => {
    const b = randomBlinding();
    const BN254_R = BigInt(
      "21888242871839275222246405745257275088548364400416034343698204186575808495617"
    );
    expect(b).toBeGreaterThan(0n);
    expect(b).toBeLessThan(BN254_R);
  });

  test("two calls return different values", () => {
    expect(randomBlinding()).not.toBe(randomBlinding());
  });
});
