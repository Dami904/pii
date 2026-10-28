/**
 * sdk/test/memo.test.ts
 * Tests for ECIES memo encryption and scanNotes.
 */

import { describe, expect, test } from "bun:test";
import {
  deriveViewingKeys,
  encodePiiAddress,
  decodePiiAddress,
  encryptMemo,
  tryDecryptMemo,
  buildMemo,
  dummyMemo,
  scanNotes,
  MEMO_BYTE_LENGTH,
} from "../src/memo.js";
import { commitment } from "../src/note.js";
import { hash2 } from "../src/hash.js";
import type { MemoPayload, LeafWithMemo } from "../src/memo.js";
import { recoverWallet } from "../src/wallet.js";
import type { PoolReadLike, RecoverViewingKeys } from "../src/wallet.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USDC_ID = 0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86en;

const SK_A = 7n;
const SK_B = 11n;
const OK_A = hash2(SK_A, 0n);
const OK_B = hash2(SK_B, 0n);

const keysA = deriveViewingKeys(SK_A);
const keysB = deriveViewingKeys(SK_B);

const PAYLOAD: MemoPayload = { assetId: USDC_ID, amount: 2_500_000n, blinding: 21n };

// ── Round-trip ────────────────────────────────────────────────────────────────

describe("memo round-trip", () => {
  test("encrypt then decrypt returns original payload", () => {
    const memo = encryptMemo(keysB.encPub, PAYLOAD);
    const result = tryDecryptMemo(keysB.encPriv, memo);
    expect(result).not.toBeNull();
    expect(result!.assetId).toBe(PAYLOAD.assetId);
    expect(result!.amount).toBe(PAYLOAD.amount);
    expect(result!.blinding).toBe(PAYLOAD.blinding);
  });

  test("wrong key returns null", () => {
    const memo = encryptMemo(keysB.encPub, PAYLOAD);
    const result = tryDecryptMemo(keysA.encPriv, memo); // wrong key
    expect(result).toBeNull();
  });

  test("tampered ciphertext returns null", () => {
    const memo = encryptMemo(keysB.encPub, PAYLOAD);
    // Flip one byte in the ciphertext region (after ephPub + nonce = 45B)
    const buf = Buffer.from(memo.slice(2), "hex");
    buf[50] ^= 0xff;
    const tampered = ("0x" + buf.toString("hex")) as `0x${string}`;
    expect(tryDecryptMemo(keysB.encPriv, tampered)).toBeNull();
  });

  test("all memos have equal length = " + MEMO_BYTE_LENGTH, () => {
    for (let i = 0; i < 8; i++) {
      const memo = encryptMemo(keysB.encPub, {
        assetId: USDC_ID,
        amount: BigInt(i * 1_000_000),
        blinding: BigInt(i + 1),
      });
      const len = (memo.length - 2) / 2;
      expect(len).toBe(MEMO_BYTE_LENGTH);
    }
    // dummy also has same length
    const dm = dummyMemo();
    expect((dm.length - 2) / 2).toBe(MEMO_BYTE_LENGTH);
  });
});

// ── scanNotes ────────────────────────────────────────────────────────────────

describe("scanNotes", () => {
  // Rebuild the E2E scenario: 7 leaves, recipient is B (sk=11).
  // Leaves 0–2: deposits for A, Leaf 3: out_recipient for B (2.5M),
  // Leaves 4–6: change/fee outputs for A and relayer.

  const CMT_A0 = commitment({ assetId: USDC_ID, amount: 2_000_000n, ownerKey: OK_A, blinding: 11n });
  const CMT_A1 = commitment({ assetId: USDC_ID, amount: 1_000_000n, ownerKey: OK_A, blinding: 12n });
  const CMT_FEE = commitment({ assetId: USDC_ID, amount: 200_000n, ownerKey: OK_A, blinding: 13n });

  const NOTE_B_PAYLOAD: MemoPayload = { assetId: USDC_ID, amount: 2_500_000n, blinding: 21n };
  const CMT_B = commitment({ assetId: USDC_ID, amount: 2_500_000n, ownerKey: OK_B, blinding: 21n });

  // Build leaves: A's leaves have memos encrypted to A; B's leaf to B
  function buildLeaves(recipientMemo: `0x${string}`): LeafWithMemo[] {
    return [
      { leafIndex: 0, commitment: CMT_A0, memo: encryptMemo(keysA.encPub, { assetId: USDC_ID, amount: 2_000_000n, blinding: 11n }) },
      { leafIndex: 1, commitment: CMT_A1, memo: encryptMemo(keysA.encPub, { assetId: USDC_ID, amount: 1_000_000n, blinding: 12n }) },
      { leafIndex: 2, commitment: CMT_FEE, memo: encryptMemo(keysA.encPub, { assetId: USDC_ID, amount: 200_000n, blinding: 13n }) },
      { leafIndex: 3, commitment: CMT_B, memo: recipientMemo },
      { leafIndex: 4, commitment: 0n, memo: dummyMemo() }, // ZERO_VALUE sentinel
      { leafIndex: 5, commitment: 0n, memo: dummyMemo() },
      { leafIndex: 6, commitment: 0n, memo: dummyMemo() },
    ];
  }

  test("scanNotes finds exactly B's note in E2E leaves", () => {
    const realMemo = encryptMemo(keysB.encPub, NOTE_B_PAYLOAD);
    const leaves = buildLeaves(realMemo);

    const notesB = scanNotes(OK_B, keysB.encPriv, leaves);
    expect(notesB.length).toBe(1);
    expect(notesB[0].amount).toBe(2_500_000n);
    expect(notesB[0].blinding).toBe(21n);
    expect(notesB[0].leafIndex).toBe(3);
  });

  test("scanNotes finds all 3 of A's notes in E2E leaves", () => {
    const realMemo = encryptMemo(keysB.encPub, NOTE_B_PAYLOAD);
    const leaves = buildLeaves(realMemo);

    const notesA = scanNotes(OK_A, keysA.encPriv, leaves);
    expect(notesA.length).toBe(3);
    const amounts = notesA.map((n) => n.amount).sort((a, b) => Number(a - b));
    expect(amounts).toEqual([200_000n, 1_000_000n, 2_000_000n]);
  });

  test("FORGED MEMO: rejected by scanNotes even with correct owner key", () => {
    // Attacker claims to encrypt a note with amount=1e12 for B, referencing leaf 3 (which actually holds 2.5M)
    const forgedPayload: MemoPayload = {
      assetId: USDC_ID,
      amount: 1_000_000_000_000n, // inflated
      blinding: 21n,              // same blinding as real note
    };
    // Commitment recomputed from forged payload would differ from CMT_B
    const forgedMemo = encryptMemo(keysB.encPub, forgedPayload);
    const leaves = buildLeaves(forgedMemo);

    const notesB = scanNotes(OK_B, keysB.encPriv, leaves);
    // The forged memo decrypts fine (right key) but cmt(assetId, 1e12, OK_B, 21) != CMT_B → rejected
    expect(notesB.length).toBe(0);
  });

  test("missing memo slot yields no note", () => {
    const leaves: LeafWithMemo[] = [
      { leafIndex: 3, commitment: CMT_B, memo: undefined },
    ];
    const notesB = scanNotes(OK_B, keysB.encPriv, leaves);
    expect(notesB.length).toBe(0);
  });
});

// ── Pii address ───────────────────────────────────────────────────────────────

describe("Pii address", () => {
  test("round-trip encodes and decodes", () => {
    const addr = encodePiiAddress(OK_B, keysB.encPub);
    expect(addr.startsWith("pii:")).toBe(true);
    const decoded = decodePiiAddress(addr);
    expect(decoded.ownerKey).toBe(OK_B);
    expect(decoded.encPub).toEqual(keysB.encPub);
  });

  test("bad checksum is rejected", () => {
    const addr = encodePiiAddress(OK_B, keysB.encPub);
    // Corrupt the last character of the checksum
    const corrupted = addr.slice(0, -1) + (addr.endsWith("a") ? "b" : "a");
    expect(() => decodePiiAddress(corrupted)).toThrow("checksum mismatch");
  });

  test("wrong prefix rejected", () => {
    expect(() => decodePiiAddress("eth:deadbeef")).toThrow("not a Pii address");
  });
});

// ── buildMemo helper ──────────────────────────────────────────────────────────

describe("buildMemo", () => {
  test("amount=0 returns dummy (cannot be decrypted as a valid payload)", () => {
    const memo = buildMemo(keysB.encPub, { assetId: USDC_ID, amount: 0n, blinding: 0n });
    expect((memo.length - 2) / 2).toBe(MEMO_BYTE_LENGTH);
    expect(memo.startsWith("0x")).toBe(true);
  });

  test("undefined encPub returns dummy", () => {
    const memo = buildMemo(undefined, PAYLOAD);
    expect((memo.length - 2) / 2).toBe(MEMO_BYTE_LENGTH);
  });
});

// ── dummy memo starts with valid compressed-point prefix ──────────────────────

describe("dummyMemo prefix", () => {
  test("every dummy memo starts with 0x02 or 0x03 (valid compressed point prefix)", () => {
    for (let i = 0; i < 20; i++) {
      const dm = dummyMemo();
      const firstByte = parseInt(dm.slice(2, 4), 16);
      expect(firstByte === 0x02 || firstByte === 0x03).toBe(true);
    }
  });

  test("seeded dummy memo is reproducible", () => {
    const seed = new Uint8Array(32).fill(0xab);
    const dm1 = dummyMemo(seed);
    const dm2 = dummyMemo(seed);
    expect(dm1).toBe(dm2);
  });
});

// ── recoverWallet ─────────────────────────────────────────────────────────────

describe("recoverWallet", () => {
  // Simulated pool with two notes spent (leafIndex 0 + 1)
  function makeMockPool(spentNullifiers: Set<bigint>): PoolReadLike {
    return {
      read: {
        nullifierSpent: async ([nf]: [bigint]) => spentNullifiers.has(nf),
      },
    };
  }

  test("recovers unspent notes from leaves with memos, marks spent correctly", async () => {
    // A has 3 deposit notes: amounts 2M, 1M, 200k
    const notePayloads: Array<{ amount: bigint; blinding: bigint }> = [
      { amount: 2_000_000n, blinding: 11n },
      { amount: 1_000_000n, blinding: 12n },
      { amount: 200_000n, blinding: 13n },
    ];

    // Build leaves with memos encrypted to A
    const leaves: LeafWithMemo[] = notePayloads.map((p, i) => ({
      leafIndex: i,
      commitment: commitment({ assetId: USDC_ID, amount: p.amount, ownerKey: OK_A, blinding: p.blinding }),
      memo: encryptMemo(keysA.encPub, { assetId: USDC_ID, amount: p.amount, blinding: p.blinding }),
    }));

    // Compute nullifiers for notes 0 and 1 (those two are spent)
    const { nullifier: computeNullifier } = await import("../src/note.js");
    const nf0 = computeNullifier({ assetId: USDC_ID, amount: 2_000_000n, ownerKey: OK_A, blinding: 11n }, SK_A);
    const nf1 = computeNullifier({ assetId: USDC_ID, amount: 1_000_000n, ownerKey: OK_A, blinding: 12n }, SK_A);
    const spent = new Set([nf0, nf1]);

    const vk: RecoverViewingKeys = { ownerKey: OK_A, encPriv: keysA.encPriv };
    const store = await recoverWallet(SK_A, vk, leaves, makeMockPool(spent));

    // Only the 200k note (index 2) should be unspent
    const unspent = store.unspent(USDC_ID);
    expect(unspent.length).toBe(1);
    expect(unspent[0].amount).toBe(200_000n);
    expect(unspent[0].leafIndex).toBe(2);
  });
});
