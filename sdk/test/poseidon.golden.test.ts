/**
 * Stage 0 — Poseidon2 golden-vector gate (TypeScript side)
 *
 * Tests that @zkpassport/poseidon2 reproduces the exact same outputs as
 * the Noir sponge (std::hash::poseidon2_permutation, t=4, rate=3, IV=n<<64).
 *
 * If ANY test fails, it is a hard blocker. Do NOT proceed to Stage 1.
 *
 * Run: bun test sdk/test/poseidon.golden.test.ts
 */

import { describe, test, expect } from "bun:test";
import { poseidon2Hash } from "@zkpassport/poseidon2";
import golden from "./poseidon.golden.json";

// ── Parse golden vectors from JSON ──────────────────────────────────────────

function bigintFromHex(hex: string): bigint {
  return BigInt(hex);
}

const GV = {
  hash2_1_2:           bigintFromHex(golden.vectors.hash2_1_2),
  hash2_0_0:           bigintFromHex(golden.vectors.hash2_0_0),
  hash3_1_2_3:         bigintFromHex(golden.vectors.hash3_1_2_3),
  hash4_1_2_3_4:       bigintFromHex(golden.vectors.hash4_1_2_3_4),
  hash8_1_to_8:        bigintFromHex(golden.vectors.hash8_1_to_8),
  zeros_1:             bigintFromHex(golden.vectors.zeros_1),
  empty_tree_root_d20: bigintFromHex(golden.vectors.empty_tree_root_d20),
};

// ── Wrapper around @zkpassport/poseidon2 ────────────────────────────────────
// poseidon2Hash(inputs: bigint[]) returns bigint

function hash2(a: bigint, b: bigint): bigint {
  return poseidon2Hash([a, b]);
}
function hash3(a: bigint, b: bigint, c: bigint): bigint {
  return poseidon2Hash([a, b, c]);
}
function hash4(a: bigint, b: bigint, c: bigint, d: bigint): bigint {
  return poseidon2Hash([a, b, c, d]);
}
function hash8(a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, g: bigint, h: bigint): bigint {
  return poseidon2Hash([a, b, c, d, e, f, g, h]);
}
// ZERO_VALUE = keccak256("pii-shielded-pool-v1") % BN254_R (from PiiMerkle.ZERO_VALUE)
const ZERO_VALUE = 0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466n;

function emptyTreeRoot(): bigint {
  // zeros[0] = ZERO_VALUE; zeros[i+1] = hash2(zeros[i], zeros[i])
  let z = ZERO_VALUE;
  for (let i = 0; i < 20; i++) z = hash2(z, z);
  return z;
}

// ── Golden-vector tests ──────────────────────────────────────────────────────

describe("Poseidon2 golden-vector gate (TS == Noir)", () => {
  test("hash2(1, 2)", () => {
    const got = hash2(1n, 2n);
    console.log("TS hash2(1,2) =", "0x" + got.toString(16).padStart(64, "0"));
    expect(got).toBe(GV.hash2_1_2);
  });

  test("hash2(0, 0)", () => {
    const got = hash2(0n, 0n);
    console.log("TS hash2(0,0) =", "0x" + got.toString(16).padStart(64, "0"));
    expect(got).toBe(GV.hash2_0_0);
  });

  test("hash3(1, 2, 3)", () => {
    const got = hash3(1n, 2n, 3n);
    console.log("TS hash3(1,2,3) =", "0x" + got.toString(16).padStart(64, "0"));
    expect(got).toBe(GV.hash3_1_2_3);
  });

  test("hash4(1, 2, 3, 4)", () => {
    const got = hash4(1n, 2n, 3n, 4n);
    console.log("TS hash4(1,2,3,4) =", "0x" + got.toString(16).padStart(64, "0"));
    expect(got).toBe(GV.hash4_1_2_3_4);
  });

  test("hash8(1..8)", () => {
    const got = hash8(1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n);
    console.log("TS hash8(1..8) =", "0x" + got.toString(16).padStart(64, "0"));
    expect(got).toBe(GV.hash8_1_to_8);
  });

  test("zeros[1] = hash2(ZERO_VALUE, ZERO_VALUE)", () => {
    const got = hash2(ZERO_VALUE, ZERO_VALUE);
    expect(got).toBe(GV.zeros_1);
  });

  test("depth-20 empty Merkle tree root (zeros[20])", () => {
    const got = emptyTreeRoot();
    console.log("TS zeros[20] =", "0x" + got.toString(16).padStart(64, "0"));
    expect(got).toBe(GV.empty_tree_root_d20);
  });
});
