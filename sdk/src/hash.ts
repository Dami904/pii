/**
 * sdk/src/hash.ts
 * Poseidon2 helpers and BN254 field constant — shared across all SDK modules.
 */

import { poseidon2Hash } from "@zkpassport/poseidon2";

export const BN254_R = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

export const ZERO_VALUE = BigInt(
  "0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466"
);

export function hash2(a: bigint, b: bigint): bigint {
  return poseidon2Hash([a, b]);
}

export function hash3(a: bigint, b: bigint, c: bigint): bigint {
  return poseidon2Hash([a, b, c]);
}
