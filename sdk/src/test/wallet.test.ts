/**
 * sdk/src/test/wallet.test.ts
 * Tests for NoteStore: add, balance, selectNotes edge cases, refreshSpent.
 */

import { describe, test, expect } from "bun:test";
import { NoteStore, MemoryStorage } from "../wallet.js";
import { hash2 } from "../hash.js";
import type { Note } from "../note.js";

const USDC_ID = BigInt("0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86e");
const OTHER_ID = BigInt("0x1234000000000000000000000000000000000000000000000000000000000001");
const OK_A = hash2(7n, 0n);

function makeNote(amount: bigint, leafIndex: number, assetId = USDC_ID): Note {
  return { assetId, amount, ownerKey: OK_A, blinding: BigInt(leafIndex + 1), leafIndex };
}

describe("NoteStore — add / balance / unspent", () => {
  test("balance starts at 0", () => {
    const s = new NoteStore();
    expect(s.balance(USDC_ID)).toBe(0n);
  });

  test("balance sums unspent notes", () => {
    const s = new NoteStore();
    s.add(makeNote(1_000_000n, 0));
    s.add(makeNote(2_000_000n, 1));
    expect(s.balance(USDC_ID)).toBe(3_000_000n);
  });

  test("spent notes excluded from balance", () => {
    const s = new NoteStore();
    s.add(makeNote(1_000_000n, 0));
    s.add(makeNote(2_000_000n, 1));
    s.markSpent(0);
    expect(s.balance(USDC_ID)).toBe(2_000_000n);
  });

  test("balance is isolated by assetId", () => {
    const s = new NoteStore();
    s.add(makeNote(500_000n, 0, USDC_ID));
    s.add(makeNote(9_999_999n, 1, OTHER_ID));
    expect(s.balance(USDC_ID)).toBe(500_000n);
    expect(s.balance(OTHER_ID)).toBe(9_999_999n);
  });

  test("add replaces note with same leafIndex", () => {
    const s = new NoteStore();
    s.add(makeNote(100n, 0));
    s.add({ ...makeNote(999n, 0) });
    expect(s.balance(USDC_ID)).toBe(999n);
    expect(s.unspent(USDC_ID).length).toBe(1);
  });
});

describe("NoteStore — selectNotes", () => {
  test("selects a single note that covers the amount", () => {
    const s = new NoteStore();
    s.add(makeNote(1_000_000n, 0));
    s.add(makeNote(500_000n, 1));
    const sel = s.selectNotes(USDC_ID, 800_000n);
    expect(sel.length).toBe(1);
    expect(sel[0].amount).toBe(1_000_000n);
  });

  test("selects exactly the right note (exact match)", () => {
    const s = new NoteStore();
    s.add(makeNote(500_000n, 0));
    s.add(makeNote(1_000_000n, 1));
    const sel = s.selectNotes(USDC_ID, 500_000n);
    expect(sel.length).toBe(1);
    expect(sel[0].amount).toBe(500_000n);
  });

  test("selects two notes when one is insufficient", () => {
    const s = new NoteStore();
    s.add(makeNote(600_000n, 0));
    s.add(makeNote(600_000n, 1));
    const sel = s.selectNotes(USDC_ID, 1_000_000n);
    expect(sel.length).toBe(2);
    expect(sel[0].amount + sel[1].amount).toBeGreaterThanOrEqual(1_000_000n);
  });

  test("throws 'needs consolidation' when 2 notes are not enough", () => {
    const s = new NoteStore();
    s.add(makeNote(100n, 0));
    s.add(makeNote(200n, 1));
    s.add(makeNote(300n, 2)); // total = 600, but max pair = 500
    expect(() => s.selectNotes(USDC_ID, 600n)).toThrow("consolidation");
  });

  test("throws when store is empty", () => {
    const s = new NoteStore();
    expect(() => s.selectNotes(USDC_ID, 1n)).toThrow("consolidation");
  });

  test("ignores spent notes during selection", () => {
    const s = new NoteStore();
    s.add(makeNote(2_000_000n, 0));
    s.add(makeNote(500_000n, 1));
    s.markSpent(0); // remove the big note
    expect(() => s.selectNotes(USDC_ID, 1_000_000n)).toThrow("consolidation");
  });
});

describe("NoteStore — refreshSpent", () => {
  test("marks notes as spent when pool returns true", async () => {
    const s = new NoteStore();
    const note0 = makeNote(1_000_000n, 0);
    const note1 = makeNote(500_000n, 1);
    s.add(note0);
    s.add(note1);

    // Pool says nullifier of note0 (sk=7) is spent, note1 is not
    const { nullifier: computeNf } = await import("../note.js");
    const nf0 = computeNf(note0, 7n);

    const mockPool = {
      read: {
        async nullifierSpent([nf]: [bigint]) { return nf === nf0; },
      },
    };

    await s.refreshSpent(mockPool, 7n);

    expect(s.unspent(USDC_ID).length).toBe(1);
    expect(s.unspent(USDC_ID)[0].leafIndex).toBe(1);
  });

  test("balance correct after refreshSpent", async () => {
    const s = new NoteStore();
    const note = makeNote(1_000_000n, 0);
    s.add(note);

    const { nullifier: computeNf } = await import("../note.js");
    const nf = computeNf(note, 7n);
    const mockPool = { read: { async nullifierSpent([n]: [bigint]) { return n === nf; } } };

    await s.refreshSpent(mockPool, 7n);
    expect(s.balance(USDC_ID)).toBe(0n);
  });
});
