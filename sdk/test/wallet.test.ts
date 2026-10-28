/**
 * sdk/test/wallet.test.ts
 *
 * Unit tests for leavesWithMemos + recoverWallet (SyncResult overload).
 *
 * Uses a mock PublicClientLike so no anvil / on-chain calls are needed.
 */

import { describe, it, expect } from "bun:test";
import { hash2 } from "../src/hash.js";
import { commitment as noteCommitment } from "../src/note.js";
import type { Note } from "../src/note.js";
import { encryptMemo, deriveViewingKeys } from "../src/memo.js";
import { buildTree, leavesWithMemos, syncTree } from "../src/tree.js";
import type { SyncResult, PublicClientLike, PoolContractLike } from "../src/tree.js";
import { recoverWallet } from "../src/wallet.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SK_ALICE   = 0xaa11bb22cc33n;
const OK_ALICE   = hash2(SK_ALICE, 0n);
const viewAlice  = deriveViewingKeys(SK_ALICE);

const SK_BOB    = 0xbb22cc33dd44n;
const OK_BOB    = hash2(SK_BOB, 0n);
const viewBob   = deriveViewingKeys(SK_BOB);

const ASSET_ID = hash2(0x3600000000000000000000000000000000000000n, 0n);

const ALICE_AMOUNT   = 5_000_000n;
const ALICE_BLINDING = 42n;
const BOB_AMOUNT     = 1_234_567n;
const BOB_BLINDING   = 99n;

// Memos encrypted to their owners' viewing keys
const seed1 = new Uint8Array(32); seed1[31] = 1;
const seed2 = new Uint8Array(32); seed2[31] = 2;

const aliceMemo = encryptMemo(
  viewAlice.encPub,
  { amount: ALICE_AMOUNT, blinding: ALICE_BLINDING, assetId: ASSET_ID },
  seed1,
);
const bobMemo = encryptMemo(
  viewBob.encPub,
  { amount: BOB_AMOUNT, blinding: BOB_BLINDING, assetId: ASSET_ID },
  seed2,
);

// Build the expected commitments
const aliceNote: Note = { assetId: ASSET_ID, amount: ALICE_AMOUNT, ownerKey: OK_ALICE, blinding: ALICE_BLINDING };
const bobNote: Note   = { assetId: ASSET_ID, amount: BOB_AMOUNT,   ownerKey: OK_BOB,   blinding: BOB_BLINDING };
const aliceCmt = noteCommitment(aliceNote);
const bobCmt   = noteCommitment(bobNote);

// Leaves: [aliceCmt @ 0, bobCmt @ 1]
const leaves = [aliceCmt, bobCmt];
const tree   = buildTree(leaves);

// ── leavesWithMemos ───────────────────────────────────────────────────────────

describe("leavesWithMemos", () => {
  it("maps each leaf to its memo from memosByIndex", () => {
    const memosByIndex = new Map<number, `0x${string}`>([
      [0, aliceMemo],
      [1, bobMemo],
    ]);
    const sync: SyncResult = { tree, leaves, memosByIndex };
    const lwm = leavesWithMemos(sync);

    expect(lwm.length).toBe(2);
    expect(lwm[0]).toEqual({ leafIndex: 0, commitment: aliceCmt, memo: aliceMemo });
    expect(lwm[1]).toEqual({ leafIndex: 1, commitment: bobCmt,   memo: bobMemo });
  });

  it("sets memo to undefined for leaves without a memo entry", () => {
    const memosByIndex = new Map<number, `0x${string}`>([[0, aliceMemo]]);
    const sync: SyncResult = { tree, leaves, memosByIndex };
    const lwm = leavesWithMemos(sync);

    expect(lwm[0].memo).toBe(aliceMemo);
    expect(lwm[1].memo).toBeUndefined();
  });

  it("returns empty array for empty SyncResult", () => {
    const emptyTree = buildTree([]);
    const sync: SyncResult = { tree: emptyTree, leaves: [], memosByIndex: new Map() };
    expect(leavesWithMemos(sync)).toEqual([]);
  });
});

// ── recoverWallet (SyncResult overload) ──────────────────────────────────────

/** Minimal PoolContractLike: no nullifiers are spent. */
function makePool(): PoolContractLike & { read: { nullifierSpent(args: [bigint]): Promise<boolean> } } {
  return {
    read: {
      isKnownRoot: () => Promise.resolve(true),
      nullifierSpent: () => Promise.resolve(false),
    },
  };
}

/** Build a SyncResult with memos for both Alice and Bob. */
function makeSyncResult(): SyncResult {
  const memosByIndex = new Map<number, `0x${string}`>([
    [0, aliceMemo],
    [1, bobMemo],
  ]);
  return { tree, leaves, memosByIndex };
}

describe("recoverWallet (SyncResult overload)", () => {
  it("Alice finds her note when given SyncResult directly", async () => {
    const pool  = makePool();
    const sync  = makeSyncResult();
    const store = await recoverWallet(
      SK_ALICE,
      { ownerKey: OK_ALICE, encPriv: viewAlice.encPriv },
      sync,
      pool,
    );
    const notes = store.unspent(ASSET_ID);
    expect(notes.length).toBe(1);
    expect(notes[0].amount).toBe(ALICE_AMOUNT);
    expect(notes[0].blinding).toBe(ALICE_BLINDING);
    expect(notes[0].leafIndex).toBe(0);
  });

  it("Bob finds his note when given SyncResult directly", async () => {
    const pool  = makePool();
    const sync  = makeSyncResult();
    const store = await recoverWallet(
      SK_BOB,
      { ownerKey: OK_BOB, encPriv: viewBob.encPriv },
      sync,
      pool,
    );
    const notes = store.unspent(ASSET_ID);
    expect(notes.length).toBe(1);
    expect(notes[0].amount).toBe(BOB_AMOUNT);
    expect(notes[0].leafIndex).toBe(1);
  });

  it("Alice finds zero notes when all memos belong to Bob", async () => {
    const pool = makePool();
    const sync: SyncResult = {
      tree,
      leaves,
      memosByIndex: new Map([[0, bobMemo], [1, bobMemo]]),
    };
    const store = await recoverWallet(
      SK_ALICE,
      { ownerKey: OK_ALICE, encPriv: viewAlice.encPriv },
      sync,
      pool,
    );
    expect(store.unspent(ASSET_ID).length).toBe(0);
  });

  it("returns empty store for empty SyncResult", async () => {
    const pool      = makePool();
    const emptyTree = buildTree([]);
    const sync: SyncResult = { tree: emptyTree, leaves: [], memosByIndex: new Map() };
    const store = await recoverWallet(SK_ALICE, { ownerKey: OK_ALICE, encPriv: viewAlice.encPriv }, sync, pool);
    expect(store.unspent(ASSET_ID).length).toBe(0);
  });

  it("still works when leaves are passed as LeafWithMemo[] directly", async () => {
    const pool = makePool();
    const lwm  = leavesWithMemos(makeSyncResult());
    const store = await recoverWallet(
      SK_ALICE,
      { ownerKey: OK_ALICE, encPriv: viewAlice.encPriv },
      lwm,
      pool,
    );
    expect(store.unspent(ASSET_ID).length).toBe(1);
  });
});

// ── syncTree mock round-trip ───────────────────────────────────────────────────

describe("syncTree → leavesWithMemos → recoverWallet", () => {
  it("round-trip: mock events → sync → recover → finds recipient note", async () => {
    // Simulate two deposits: Alice at leaf 0, Bob at leaf 1.
    const mockClient: PublicClientLike = {
      getBlockNumber: () => Promise.resolve(5n),
      getLogs(args) {
        if (!("event" in args)) return Promise.resolve([]);
        return Promise.resolve([
          {
            args: {
              leafIndex: 0n,
              commitment: aliceCmt,
              memo:       aliceMemo,
            } as Record<string, bigint | `0x${string}` | undefined>,
            blockNumber: 1n,
          },
          {
            args: {
              leafIndex: 1n,
              commitment: bobCmt,
              memo:       bobMemo,
            } as Record<string, bigint | `0x${string}` | undefined>,
            blockNumber: 2n,
          },
        ]);
      },
    };

    const mockPool: PoolContractLike & { read: { nullifierSpent(a: [bigint]): Promise<boolean> } } = {
      read: {
        isKnownRoot:      () => Promise.resolve(true),
        nullifierSpent:   () => Promise.resolve(false),
      },
    };

    const sync  = await syncTree(mockClient, mockPool, "0x0000000000000000000000000000000000001001", 0n);
    expect(sync.leaves.length).toBe(2);

    const store = await recoverWallet(
      SK_BOB,
      { ownerKey: OK_BOB, encPriv: viewBob.encPriv },
      sync,
      mockPool,
    );
    const notes = store.unspent(ASSET_ID);
    expect(notes.length).toBe(1);
    expect(notes[0].amount).toBe(BOB_AMOUNT);
    expect(notes[0].leafIndex).toBe(1);
  });
});
