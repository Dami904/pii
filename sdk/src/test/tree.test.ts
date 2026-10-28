/**
 * sdk/src/test/tree.test.ts
 * Tests that syncTree rebuilds the 7-leaf E2E tree to ROOT_AFTER_TRANSFER,
 * and throws on a gap or an unknown root.
 */

import { describe, test, expect } from "bun:test";
import { syncTree, buildTree } from "../tree.js";
import { hash2 } from "../hash.js";
import type { PublicClientLike, PoolContractLike } from "../tree.js";

// ── Golden values from gen-e2e-fixture.ts ────────────────────────────────────

const CMT_A0     = BigInt("0x25401d063ca1ea2e93b060c3191f5221a54f9d52fd5e8f81e666d9d07d6aa812");
const CMT_A1     = BigInt("0x291c073c82e06e7981a792ed4a700d1ab55853111cb1f4c20b5a69e67fdc7c86");
const CMT_FEE    = BigInt("0x02589e958e1914010710d07839b95cda441ab5381b267cff8e5395f87eb2ca3d");
const OUT_RECIP  = BigInt("0x10c7132167488662b478551f5621750b5ac7154ae9d962a266dbede7681bc072");
const OUT_CHG    = BigInt("0x027bfe3dad0b995d2a93ddb4349d4f4dd6c7ad4a6552d6ae5f9e694c6608cf3d");
const OUT_FEE    = BigInt("0x27b49af6c3e50a44e47b74084da2b11939c3e2cf751340f282d50ceb40fa3a7f");
const OUT_FEE_CHG = BigInt("0x1e44673056bf3404c2bd09d3ef8fc25ea094d13da085dd4a5705b8359a592370");

const ROOT_3             = BigInt("0x0e14666af22b282d457244bb3c6c825c2872c37748e30b120b74e9ed9b8364a2");
const ROOT_AFTER_TRANSFER = BigInt("0x2e4650c96ea6622aa0a9bc0637936d5a096e9fb4193010c3d852e7861ce617bb");

const LEAVES_7 = [CMT_A0, CMT_A1, CMT_FEE, OUT_RECIP, OUT_CHG, OUT_FEE, OUT_FEE_CHG];

const POOL_ADDR = "0x0000000000000000000000000000000000001001" as const;

// ── Mock builders ─────────────────────────────────────────────────────────────

/** Build a mock publicClient that returns events for the given leaves. */
function mockClient(
  leaves: Array<{ leafIndex: number; commitment: bigint; memo?: `0x${string}` }>
): PublicClientLike {
  return {
    async getBlockNumber() { return 100n; },
    async getLogs() {
      return leaves.map((l) => ({
        args: { leafIndex: BigInt(l.leafIndex), commitment: l.commitment, memo: l.memo },
        blockNumber: 10n,
      }));
    },
  };
}

/** Build a mock pool that accepts a set of known roots. */
function mockPool(knownRoots: Set<bigint>): PoolContractLike {
  return {
    read: {
      async isKnownRoot([root]) { return knownRoots.has(root); },
    },
  };
}

// ── buildTree unit tests ──────────────────────────────────────────────────────

describe("buildTree", () => {
  test("3-leaf root matches ROOT_3", () => {
    const t = buildTree([CMT_A0, CMT_A1, CMT_FEE]);
    expect(t.root).toBe(ROOT_3);
  });

  test("7-leaf root matches ROOT_AFTER_TRANSFER", () => {
    const t = buildTree(LEAVES_7);
    expect(t.root).toBe(ROOT_AFTER_TRANSFER);
  });

  test("authPath for leaf 0 (3-leaf tree) verifies against root", () => {
    const t = buildTree([CMT_A0, CMT_A1, CMT_FEE]);
    const path = t.authPath(0);
    expect(path).not.toBeNull();
    let cur = CMT_A0;
    for (let i = 0; i < 20; i++) {
      const bit = path!.bits[i];
      const sib = path!.siblings[i];
      cur = bit === 0n ? hash2(cur, sib) : hash2(sib, cur);
    }
    expect(cur).toBe(ROOT_3);
  });

  test("authPath returns null for out-of-range index", () => {
    const t = buildTree([CMT_A0]);
    expect(t.authPath(5)).toBeNull();
  });
});

// ── syncTree tests ────────────────────────────────────────────────────────────

describe("syncTree", () => {
  test("rebuilds 7-leaf E2E tree to ROOT_AFTER_TRANSFER", async () => {
    const events = LEAVES_7.map((c, i) => ({ leafIndex: i, commitment: c }));
    const client = mockClient(events);
    const pool = mockPool(new Set([ROOT_AFTER_TRANSFER]));

    const { tree, leaves } = await syncTree(client, pool, POOL_ADDR, 0n);
    expect(tree.root).toBe(ROOT_AFTER_TRANSFER);
    expect(leaves.length).toBe(7);
  });

  test("throws on a gap in leafIndex", async () => {
    // Skip leafIndex=2 (cmtFee)
    const events = [
      { leafIndex: 0, commitment: CMT_A0 },
      { leafIndex: 1, commitment: CMT_A1 },
      { leafIndex: 3, commitment: OUT_RECIP }, // gap!
    ];
    const client = mockClient(events);
    const pool = mockPool(new Set());

    await expect(syncTree(client, pool, POOL_ADDR, 0n)).rejects.toThrow("gap");
  });

  test("throws when computed root is not known by the pool", async () => {
    const events = LEAVES_7.map((c, i) => ({ leafIndex: i, commitment: c }));
    const client = mockClient(events);
    // Pool rejects the root
    const pool = mockPool(new Set());

    await expect(syncTree(client, pool, POOL_ADDR, 0n)).rejects.toThrow(
      "not known by the pool"
    );
  });

  test("stores memos in memosByIndex", async () => {
    const events = [
      { leafIndex: 0, commitment: CMT_A0, memo: "0xc0ffee" as `0x${string}` },
      { leafIndex: 1, commitment: CMT_A1 },
    ];
    // Compute root of these 2 leaves
    const t = buildTree([CMT_A0, CMT_A1]);
    const client = mockClient(events);
    const pool = mockPool(new Set([t.root]));

    const { memosByIndex } = await syncTree(client, pool, POOL_ADDR, 0n);
    expect(memosByIndex.get(0)).toBe("0xc0ffee");
    expect(memosByIndex.has(1)).toBe(false);
  });
});
