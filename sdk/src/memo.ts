/**
 * sdk/src/memo.ts
 * ECIES encrypted memos for Pii notes.
 *
 * Viewing key derivation:
 *   enc_priv = hash2(sk, 2) mod n   (secp256k1 order; guard against 0)
 *   enc_pub  = secp256k1.getPublicKey(enc_priv, true)  → 33 bytes compressed
 *
 * Pii address = "pii:" + hex(owner_key 32B ‖ enc_pub 33B) + checksum 4B
 *   checksum = keccak256(payload)[0..3]
 *
 * encryptMemo uses secp256k1 ECDH + HKDF-SHA256 + AES-256-GCM:
 *   shared    = ECDH(ephPriv, encPub).x
 *   key       = HKDF-SHA256(ikm=shared, salt=ephPub, info="pii-memo-v1") → 32B
 *   nonce     = random 12B
 *   plaintext = version(1) ‖ assetId(32) ‖ amount(8) ‖ blinding(32) = 73B fixed
 *   memo      = ephPub(33) ‖ nonce(12) ‖ ct+tag(73+16=89B) = 134B fixed
 *
 * Every real or dummy memo is 134 bytes — size leaks nothing.
 */

import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import { keccak256 } from "viem";
import { hash2, BN254_R } from "./hash.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** secp256k1 curve order */
const SECP256K1_N = secp256k1.CURVE.n;

/** HKDF info tags */
const HKDF_INFO     = new TextEncoder().encode("pii-memo-v1");
const HKDF_INFO_EPH = new TextEncoder().encode("pii-memo-eph");
const HKDF_INFO_NON = new TextEncoder().encode("pii-memo-nonce");

/** Plaintext structure: version(1) + assetId(32) + amount(8) + blinding(32) */
const PT_LEN = 1 + 32 + 8 + 32; // 73 bytes

/** AES-GCM tag length (bytes) */
const TAG_LEN = 16;

/** Fixed memo size: ephPub(33) + nonce(12) + ct+tag(73+16) = 134 bytes */
export const MEMO_BYTE_LENGTH = 33 + 12 + PT_LEN + TAG_LEN; // 134

/** Memo version byte */
const MEMO_VERSION = 0x01;

// ── Viewing key ───────────────────────────────────────────────────────────────

export interface ViewingKeys {
  /** secp256k1 scalar — keep private */
  encPriv: bigint;
  /** Compressed 33-byte public key */
  encPub: Uint8Array;
}

/**
 * Derives viewing keys from the Pii spending key.
 *   enc_priv = hash2(sk, 2) mod n  (guard against 0)
 */
export function deriveViewingKeys(sk: bigint): ViewingKeys {
  let encPriv = hash2(sk, 2n) % SECP256K1_N;
  if (encPriv === 0n) encPriv = 1n;
  const encPub = secp256k1.getPublicKey(encPriv, true); // 33B compressed
  return { encPriv, encPub };
}

// ── Pii address ───────────────────────────────────────────────────────────────

/**
 * Encodes a Pii address from ownerKey (32B) and encPub (33B).
 * Format: "pii:" + hex(ownerKey ‖ encPub ‖ checksum)
 * Checksum = first 4 bytes of keccak256(ownerKey ‖ encPub).
 */
export function encodePiiAddress(ownerKey: bigint, encPub: Uint8Array): string {
  const payload = new Uint8Array(32 + 33);
  // ownerKey big-endian 32 bytes
  for (let i = 31; i >= 0; i--) {
    payload[i] = Number(ownerKey & 0xffn);
    ownerKey >>= 8n;
  }
  payload.set(encPub, 32);

  const payloadHex = ("0x" + buf2hex(payload)) as `0x${string}`;
  const checksumHex = keccak256(payloadHex);
  const checksum = checksumHex.slice(2, 10); // first 4B = 8 hex chars
  return "pii:" + buf2hex(payload) + checksum;
}

/**
 * Decodes a Pii address, validates the checksum, and returns {ownerKey, encPub}.
 * Throws on any format error or checksum mismatch.
 */
export function decodePiiAddress(addr: string): {
  ownerKey: bigint;
  encPub: Uint8Array;
} {
  if (!addr.startsWith("pii:")) throw new Error("not a Pii address");
  const hex = addr.slice(4);
  // 32B ownerKey + 33B encPub + 4B checksum = 69B = 138 hex chars
  if (hex.length !== 138) throw new Error("Pii address wrong length");

  const payloadHex = hex.slice(0, 130); // 65B payload = 130 hex chars
  const gotChecksum = hex.slice(130);   // 4B = 8 hex chars

  const payloadBytes = ("0x" + payloadHex) as `0x${string}`;
  const expected = keccak256(payloadBytes).slice(2, 10);
  if (gotChecksum.toLowerCase() !== expected.toLowerCase())
    throw new Error("Pii address checksum mismatch");

  const buf = hex2buf(payloadHex);
  let ownerKey = 0n;
  for (let i = 0; i < 32; i++) ownerKey = (ownerKey << 8n) | BigInt(buf[i]);
  const encPub = buf.slice(32, 65);
  return { ownerKey, encPub };
}

// ── Memo plaintext ────────────────────────────────────────────────────────────

export interface MemoPayload {
  assetId: bigint;
  /** u64: amount in token base units */
  amount: bigint;
  blinding: bigint;
}

// ── Encryption ────────────────────────────────────────────────────────────────

/**
 * Encrypts a note payload to a recipient's viewing public key.
 * Returns a hex string of exactly MEMO_BYTE_LENGTH bytes.
 *
 * @param encPub    Recipient's 33-byte compressed secp256k1 public key
 * @param payload   The note fields to encrypt
 * @param testSeed  Optional 32-byte seed for TESTS AND SCRIPTS ONLY.
 *                  When given, BOTH ephPriv and nonce are derived from it via HKDF
 *                  so the output is fully reproducible.  Never pass a testSeed in
 *                  production — it would allow anyone with the seed to recompute
 *                  the ephemeral key and decrypt.
 */
export function encryptMemo(
  encPub: Uint8Array,
  payload: MemoPayload,
  testSeed?: Uint8Array,
): `0x${string}` {
  // Ephemeral key pair — derive from testSeed when given, random otherwise.
  let ephPrivBytes: Uint8Array;
  if (testSeed) {
    // Derive a deterministic 32-byte scalar, reduce mod n, guard against 0.
    const raw = hkdf(sha256, testSeed, undefined, HKDF_INFO_EPH, 32);
    let scalar = 0n;
    for (const b of raw) scalar = (scalar << 8n) | BigInt(b);
    scalar = scalar % SECP256K1_N;
    if (scalar === 0n) scalar = 1n;
    ephPrivBytes = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) {
      ephPrivBytes[i] = Number(scalar & 0xffn);
      scalar >>= 8n;
    }
  } else {
    ephPrivBytes = secp256k1.utils.randomPrivateKey();
  }
  const ephPub = secp256k1.getPublicKey(ephPrivBytes, true); // 33B

  // ECDH shared secret (x-coordinate of shared point)
  const sharedPoint = secp256k1.getSharedSecret(ephPrivBytes, encPub, false); // 65B uncompressed
  const sharedX = sharedPoint.slice(1, 33); // x-coordinate 32B

  // HKDF key
  const key = hkdf(sha256, sharedX, ephPub, HKDF_INFO, 32);

  // Nonce — derive from testSeed when given, random otherwise.
  const nonce = testSeed
    ? hkdf(sha256, testSeed, undefined, HKDF_INFO_NON, 12)
    : crypto.getRandomValues(new Uint8Array(12));

  // Plaintext: version(1) ‖ assetId(32) ‖ amount(8) ‖ blinding(32)
  const pt = new Uint8Array(PT_LEN);
  pt[0] = MEMO_VERSION;
  writeBigInt32(pt, 1, payload.assetId);
  writeBigInt8(pt, 33, payload.amount);
  writeBigInt32(pt, 41, payload.blinding);

  // AES-256-GCM
  const cipher = gcm(key, nonce);
  const ct = cipher.encrypt(pt); // ct + 16B tag = 89B

  // Assemble: ephPub(33) ‖ nonce(12) ‖ ct+tag(89)
  const memo = new Uint8Array(MEMO_BYTE_LENGTH);
  memo.set(ephPub, 0);
  memo.set(nonce, 33);
  memo.set(ct, 45);

  return ("0x" + buf2hex(memo)) as `0x${string}`;
}

// ── Decryption ────────────────────────────────────────────────────────────────

/**
 * Attempts to decrypt a memo with the given viewing private key.
 * Returns null on ANY failure (wrong key, tampered bytes, bad version).
 * Never throws.
 */
export function tryDecryptMemo(
  encPriv: bigint,
  memo: `0x${string}`,
): MemoPayload | null {
  try {
    const buf = hex2buf(memo.slice(2));
    if (buf.length !== MEMO_BYTE_LENGTH) return null;

    const ephPub = buf.slice(0, 33);
    const nonce = buf.slice(33, 45);
    const ct = buf.slice(45); // ct + tag = PT_LEN + TAG_LEN bytes

    // ECDH
    const sharedPoint = secp256k1.getSharedSecret(encPriv, ephPub, false);
    const sharedX = sharedPoint.slice(1, 33);

    // HKDF
    const key = hkdf(sha256, sharedX, ephPub, HKDF_INFO, 32);

    // AES-256-GCM decrypt (throws if tag is wrong)
    const decipher = gcm(key, nonce);
    const pt = decipher.decrypt(ct);

    if (pt.length !== PT_LEN) return null;
    if (pt[0] !== MEMO_VERSION) return null;

    const assetId = readBigInt32(pt, 1);
    const amount = readBigInt8(pt, 33);
    const blinding = readBigInt32(pt, 41);

    return { assetId, amount, blinding };
  } catch {
    return null;
  }
}

// ── scanNotes ────────────────────────────────────────────────────────────────

import { commitment as noteCommitment } from "./note.js";
import type { Note } from "./note.js";

export interface LeafWithMemo {
  leafIndex: number;
  commitment: bigint;
  memo: `0x${string}` | undefined;
}

/**
 * Scans on-chain leaves, decrypts memos, and returns owned notes.
 *
 * Security: the decrypted payload is only accepted if
 *   commitment(assetId, amount, ownerKey, blinding) == leaf.commitment
 * A forged memo that encrypts to a valid key but references the wrong leaf
 * is silently dropped.
 *
 * @param ownerKey  The recipient's owner_key (hash2(sk, 0))
 * @param encPriv   The recipient's viewing private key
 * @param leaves    On-chain leaves with optional associated memos
 */
export function scanNotes(
  ownerKey: bigint,
  encPriv: bigint,
  leaves: LeafWithMemo[],
): Note[] {
  const notes: Note[] = [];
  for (const leaf of leaves) {
    if (!leaf.memo) continue;
    const payload = tryDecryptMemo(encPriv, leaf.memo);
    if (!payload) continue;

    // Recompute commitment and verify it matches the on-chain leaf
    const cmt = noteCommitment({
      assetId: payload.assetId,
      amount: payload.amount,
      ownerKey,
      blinding: payload.blinding,
    });
    if (cmt !== leaf.commitment) continue;

    notes.push({
      assetId: payload.assetId,
      amount: payload.amount,
      ownerKey,
      blinding: payload.blinding,
      leafIndex: leaf.leafIndex,
    });
  }
  return notes;
}

// ── Dummy memo ────────────────────────────────────────────────────────────────

/**
 * Generates a dummy memo by encrypting a random payload to a fresh throwaway key.
 * The output is a valid ECIES memo (starts with a real compressed point prefix
 * 0x02 or 0x03) and is indistinguishable from a real memo to an observer.
 *
 * @param testSeed  Optional seed for reproducibility in tests/scripts only.
 */
export function dummyMemo(testSeed?: Uint8Array): `0x${string}` {
  // Generate a throwaway recipient key (never stored or reused).
  const throwawayPriv = testSeed
    ? (() => {
        const raw = hkdf(sha256, testSeed, undefined, new TextEncoder().encode("pii-dummy-key"), 32);
        let s = 0n;
        for (const b of raw) s = (s << 8n) | BigInt(b);
        s = s % SECP256K1_N;
        if (s === 0n) s = 1n;
        const b = new Uint8Array(32);
        for (let i = 31; i >= 0; i--) { b[i] = Number(s & 0xffn); s >>= 8n; }
        return b;
      })()
    : secp256k1.utils.randomPrivateKey();
  const throwawayPub = secp256k1.getPublicKey(throwawayPriv, true);
  // Use a random (or seeded) payload — values don't matter, just fill valid fields.
  const dummySeed = testSeed
    ? hkdf(sha256, testSeed, undefined, new TextEncoder().encode("pii-dummy-payload"), 32)
    : undefined;
  return encryptMemo(throwawayPub, { assetId: 1n, amount: 1n, blinding: 1n }, dummySeed);
}

// ── Encode helpers for inputs.ts ─────────────────────────────────────────────

/**
 * Builds an encrypted memo for a note output.
 * If the output is a ZERO_VALUE sentinel (amount === 0 signals phantom),
 * returns a random dummy of the same length.
 *
 * @param encPub    Recipient's 33-byte compressed public key (or undefined for dummy)
 * @param payload   Note fields; amount === 0n → dummy
 * @param testSeed  Optional deterministic seed (for tests / scripts only)
 */
export function buildMemo(
  encPub: Uint8Array | undefined,
  payload: MemoPayload,
  testSeed?: Uint8Array,
): `0x${string}` {
  if (!encPub || payload.amount === 0n) return dummyMemo(testSeed);
  return encryptMemo(encPub, payload, testSeed);
}

// ── Byte helpers ──────────────────────────────────────────────────────────────

function buf2hex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hex2buf(hex: string): Uint8Array {
  if (hex.startsWith("0x")) hex = hex.slice(2);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}

/** Write bigint as big-endian 32 bytes into buf at offset */
function writeBigInt32(buf: Uint8Array, offset: number, v: bigint): void {
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** Write bigint as big-endian 8 bytes (u64) into buf at offset */
function writeBigInt8(buf: Uint8Array, offset: number, v: bigint): void {
  for (let i = 7; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** Read big-endian 32 bytes as bigint */
function readBigInt32(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(buf[offset + i]);
  return v;
}

/** Read big-endian 8 bytes (u64) as bigint */
function readBigInt8(buf: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[offset + i]);
  return v;
}
