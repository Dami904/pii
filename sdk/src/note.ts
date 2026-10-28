/**
 * sdk/src/note.ts
 * Note data model and commitment / nullifier computations matching SPEC §2.
 *
 * commitment = hash3(assetId, amount, hash2(ownerKey, blinding))
 * nullifier  = hash2(commitment, sk)
 */

import { BN254_R, ZERO_VALUE, hash2, hash3 } from "./hash.js";

// ── Note ─────────────────────────────────────────────────────────────────────

export interface Note {
  /** Poseidon2 hash of the asset address (e.g. USDC_ID = hash2(usdc_addr, 0)). */
  assetId: bigint;
  /** Amount in token base units (USDC: 6 decimals). */
  amount: bigint;
  /** hash2(sk, 0) — the owner's public identity. */
  ownerKey: bigint;
  /** Random 31-byte blinding factor. */
  blinding: bigint;
  /** Tree leaf index, set after the note is inserted on-chain. */
  leafIndex?: number;
  /** Whether this note has been spent (nullifier emitted). */
  spent?: boolean;
}

// ── Core crypto ───────────────────────────────────────────────────────────────

/**
 * secret = hash2(ownerKey, blinding)
 * Used as the third input to noteCommitment.
 */
export function depositSecret(ownerKey: bigint, blinding: bigint): bigint {
  return hash2(ownerKey, blinding);
}

/**
 * commitment = hash3(assetId, amount, secret)   where secret = hash2(ownerKey, blinding)
 * Returns ZERO_VALUE when amount === 0n (phantom/change note).
 */
export function commitment(note: Pick<Note, "assetId" | "amount" | "ownerKey" | "blinding">): bigint {
  if (note.amount === 0n) return ZERO_VALUE;
  const secret = depositSecret(note.ownerKey, note.blinding);
  return hash3(note.assetId, note.amount, secret);
}

/**
 * nullifier = hash2(commitment, sk)
 */
export function nullifier(note: Pick<Note, "assetId" | "amount" | "ownerKey" | "blinding">, sk: bigint): bigint {
  return hash2(commitment(note), sk);
}

// ── Randomness ────────────────────────────────────────────────────────────────

/**
 * Generates a cryptographically random blinding factor in [1, r-1].
 * Uses crypto.getRandomValues for 32 bytes, reduces mod r, and re-rolls on 0.
 */
export function randomBlinding(): bigint {
  const buf = new Uint8Array(32);
  // Works in browser (Web Crypto) and Bun (which exposes globalThis.crypto).
  crypto.getRandomValues(buf);
  let v = 0n;
  for (const byte of buf) v = (v << 8n) | BigInt(byte);
  v %= BN254_R;
  // Re-roll on 0 (probability ≈ 1/r ≈ 4.5e-77 — essentially impossible)
  if (v === 0n) v = 1n;
  return v;
}

export { ZERO_VALUE };
