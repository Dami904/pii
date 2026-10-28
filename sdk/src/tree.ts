/**
 * sdk/src/tree.ts
 * Syncs the Pii Merkle tree from on-chain NewCommitment events.
 *
 * - Reads events in 10k-block chunks.
 * - Orders leaves by leafIndex; asserts no gaps (throws on mismatch).
 * - Rebuilds the depth-20 incremental Merkle tree.
 * - Validates the computed root against pool.isKnownRoot(root); throws if not.
 */

import { ZERO_VALUE, hash2 } from "./hash.js";
import type { LeafWithMemo as _LeafWithMemo } from "./memo.js";
export type { LeafWithMemo } from "./memo.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NewCommitmentEvent {
  leafIndex: number;
  commitment: bigint;
  /** Optional encrypted memo bytes. */
  memo?: `0x${string}`;
}

/** Minimal viem-style publicClient interface. */
export interface PublicClientLike {
  getLogs(args: {
    address: `0x${string}`;
    event: {
      type: "event";
      name: string;
      inputs: Array<{ name: string; type: string; indexed?: boolean }>;
    };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<
    Array<{
      args: Record<string, bigint | `0x${string}` | undefined>;
      blockNumber: bigint | null;
    }>
  >;
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<Array<{ blockNumber: bigint | null }>>;
}

/** Minimal pool contract interface for root validation. */
export interface PoolContractLike {
  read: {
    isKnownRoot(args: [bigint]): Promise<boolean>;
  };
}

// ── Incremental Merkle tree ───────────────────────────────────────────────────

export const DEPTH = 20;

/**
 * Root of the empty depth-20 Merkle tree (all leaves = ZERO_VALUE).
 * Matches PiiMerkle.emptyRoot() on-chain.
 */
export const EMPTY_TREE_ROOT =
  0x19ee29beb37701dd87b245c58cc348522c86f063f3aa049d19d6fddc71de23c7n;

export function computeZeros(): bigint[] {
  const z: bigint[] = new Array(DEPTH + 1);
  z[0] = ZERO_VALUE;
  for (let i = 1; i <= DEPTH; i++) z[i] = hash2(z[i - 1], z[i - 1]);
  return z;
}

export interface MerkleTree {
  /** All leaf commitments in insertion order. */
  leaves: bigint[];
  /** Current root after all insertions. */
  root: bigint;
  /**
   * Auth path for leaf at `index` against the current root.
   * Returns null if index >= leaves.length.
   */
  authPath(index: number): { siblings: bigint[]; bits: bigint[] } | null;
}

/**
 * Builds the incremental Merkle tree (mirrors PiiMerkle._insert).
 * Returns a MerkleTree that can compute auth paths against the current root.
 */
export function buildTree(leaves: bigint[]): MerkleTree {
  const zeros = computeZeros();
  // filled[i] = left node at level i that has been filled but not yet paired
  const filled: bigint[] = zeros.slice();
  // nodes[i] = array of all nodes at level i in insertion order
  // We store the full node history so we can reconstruct any path.
  const nodeHistory: bigint[][] = Array.from({ length: DEPTH + 1 }, () => []);

  let lastRoot = zeros[DEPTH];

  for (let idx = 0; idx < leaves.length; idx++) {
    let cur = leaves[idx];
    nodeHistory[0].push(cur);

    for (let i = 0; i < DEPTH; i++) {
      const bit = (idx >> i) & 1;
      if (bit === 0) {
        filled[i] = cur;
        cur = hash2(cur, zeros[i]);
      } else {
        cur = hash2(filled[i], cur);
      }
      // Record the internal node produced at this level for this insertion
      if (i < DEPTH - 1) {
        nodeHistory[i + 1].push(cur);
      }
    }
    lastRoot = cur;
  }

  return {
    leaves: leaves.slice(),
    root: lastRoot,

    authPath(index: number) {
      if (index < 0 || index >= leaves.length) return null;
      const siblings: bigint[] = new Array(DEPTH).fill(0n);
      const bits: bigint[] = new Array(DEPTH).fill(0n);

      // Build the path against the current (post-all-insertions) root.
      // We must replay ALL leaves (not just 0..index) because the sibling of
      // leaf `index` at level 0 is its neighbor (inserted after it if index is even).
      // Strategy: replay all insertions tracking filled2[]; when idx2 === index
      // record the sibling that was in place at THAT moment.  For a left-child
      // (bit=0) that sibling is zeros2[i] at insertion time — which is what
      // the prover circuit will also see.  For a right-child (bit=1) the sibling
      // is filled2[i] at insertion time.
      // But "zeros2[i]" evolves only when insertions go left at level i — they
      // don't in the basic buildTree above.  Actually buildTree never mutates
      // zeros; it only mutates filled[].  So zeros[i] is always the static zero.
      //
      // The real tree path the CIRCUIT uses is the path against the CURRENT
      // root (post all insertions), not the insertion-time path.  We compute
      // this by building the full tree level-by-level.
      //
      // Build the full node array at each level (sparse — only filled positions).
      const nodeAtLevel: Map<number, bigint>[] = Array.from(
        { length: DEPTH + 1 },
        () => new Map<number, bigint>()
      );
      // Level 0: the leaves
      for (let k = 0; k < leaves.length; k++) {
        nodeAtLevel[0].set(k, leaves[k]);
      }
      // Build higher levels
      const z = computeZeros();
      for (let lev = 1; lev <= DEPTH; lev++) {
        const prevWidth = Math.ceil(leaves.length / (1 << (lev - 1)));
        const width = Math.ceil(prevWidth / 2);
        for (let k = 0; k < width || k <= Math.ceil(leaves.length / (1 << lev)); k++) {
          const left  = nodeAtLevel[lev - 1].get(2 * k) ?? z[lev - 1];
          const right = nodeAtLevel[lev - 1].get(2 * k + 1) ?? z[lev - 1];
          // Only store if at least one child exists
          if (nodeAtLevel[lev - 1].has(2 * k) || nodeAtLevel[lev - 1].has(2 * k + 1)) {
            nodeAtLevel[lev].set(k, hash2(left, right));
          }
        }
      }
      // Extract path for `index`
      let pos = index;
      for (let i = 0; i < DEPTH; i++) {
        const bit = pos & 1;
        bits[i] = BigInt(bit);
        const sibPos = bit === 0 ? pos + 1 : pos - 1;
        siblings[i] = nodeAtLevel[i].get(sibPos) ?? z[i];
        pos >>= 1;
      }
      return { siblings, bits };
    },
  };
}

// ── NewCommitment ABI fragment ────────────────────────────────────────────────

const NEW_COMMITMENT_EVENT = {
  type: "event" as const,
  name: "NewCommitment",
  inputs: [
    { name: "leafIndex", type: "uint256", indexed: true },
    { name: "commitment", type: "uint256", indexed: false },
    { name: "memo", type: "bytes", indexed: false },
  ],
};

// ── syncTree ──────────────────────────────────────────────────────────────────

const CHUNK_SIZE = 10_000n;

export interface SyncResult {
  tree: MerkleTree;
  leaves: bigint[];
  memosByIndex: Map<number, `0x${string}`>;
}

/**
 * Syncs the Pii Merkle tree from on-chain NewCommitment events.
 *
 * @param publicClient - viem-compatible public client
 * @param pool         - viem contract instance with `isKnownRoot` readable
 * @param poolAddress  - pool contract address (checksummed hex)
 * @param fromBlock    - first block to scan (use deployment block)
 */
export async function syncTree(
  publicClient: PublicClientLike,
  pool: PoolContractLike,
  poolAddress: `0x${string}`,
  fromBlock: bigint
): Promise<SyncResult> {
  const head = await publicClient.getBlockNumber();

  // Collect all events in 10k-block chunks
  const rawEvents: Array<{ leafIndex: number; commitment: bigint; memo?: `0x${string}` }> = [];

  for (let start = fromBlock; start <= head; start += CHUNK_SIZE) {
    const end = start + CHUNK_SIZE - 1n < head ? start + CHUNK_SIZE - 1n : head;
    const logs = await publicClient.getLogs({
      address: poolAddress,
      event: NEW_COMMITMENT_EVENT,
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      const rawIdx = log.args["leafIndex"];
      const leafIndex = typeof rawIdx === "bigint" ? Number(rawIdx) : Number(rawIdx ?? 0);
      const rawCmt = log.args["commitment"];
      const cmt: bigint = typeof rawCmt === "bigint" ? rawCmt : 0n;
      const rawMemo = log.args["memo"];
      const memo: `0x${string}` | undefined =
        typeof rawMemo === "string" ? (rawMemo as `0x${string}`) : undefined;
      rawEvents.push({ leafIndex, commitment: cmt, memo });
    }
  }

  // Sort by leafIndex (events may arrive out of order across chunks)
  rawEvents.sort((a, b) => a.leafIndex - b.leafIndex);

  // Assert no gaps
  for (let i = 0; i < rawEvents.length; i++) {
    if (rawEvents[i].leafIndex !== i) {
      throw new Error(
        `syncTree: gap in NewCommitment events — expected leafIndex ${i}, got ${rawEvents[i].leafIndex}. ` +
          "The tree is inconsistent; do not prove against this state."
      );
    }
  }

  const leaves = rawEvents.map((e) => e.commitment);
  const tree = buildTree(leaves);

  // Validate root against the contract
  const known = await pool.read.isKnownRoot([tree.root]);
  if (!known) {
    throw new Error(
      `syncTree: computed root 0x${tree.root.toString(16)} is not known by the pool contract. ` +
        "Refusing to prove against an unvalidated root."
    );
  }

  const memosByIndex = new Map<number, `0x${string}`>();
  for (const e of rawEvents) {
    if (e.memo !== undefined && e.memo !== "0x") {
      memosByIndex.set(e.leafIndex, e.memo);
    }
  }

  return { tree, leaves, memosByIndex };
}

// ── leavesWithMemos ───────────────────────────────────────────────────────────

/**
 * Converts a SyncResult into the LeafWithMemo[] array expected by scanNotes /
 * recoverWallet.  Each entry pairs the commitment at leaf index i with the
 * decrypted memo bytes stored in memosByIndex (undefined when absent).
 */
export function leavesWithMemos(sync: SyncResult): _LeafWithMemo[] {
  return sync.leaves.map((commitment, i) => ({
    leafIndex: i,
    commitment,
    memo: sync.memosByIndex.get(i),
  }));
}
