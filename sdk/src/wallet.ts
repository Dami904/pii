/**
 * sdk/src/wallet.ts
 * NoteStore — manages a user's notes with pluggable persistence.
 *
 * - add / markSpent / unspent / balance
 * - refreshSpent(): checks pool.nullifierSpent on-chain
 * - selectNotes(): picks up to 2 unspent notes covering `amount`
 */

import type { Note } from "./note.js";
import { nullifier as computeNullifier } from "./note.js";
import { scanNotes } from "./memo.js";
import type { LeafWithMemo } from "./memo.js";
import { leavesWithMemos } from "./tree.js";
import type { SyncResult } from "./tree.js";

// ── Pluggable storage ─────────────────────────────────────────────────────────

export interface NoteStorage {
  getAll(): Note[];
  save(notes: Note[]): void;
}

/** In-memory storage (default; suitable for browser sessionStorage wrapping). */
export class MemoryStorage implements NoteStorage {
  private notes: Note[] = [];
  getAll() { return this.notes.slice(); }
  save(notes: Note[]) { this.notes = notes.slice(); }
}

// ── Pool interface ────────────────────────────────────────────────────────────

export interface PoolReadLike {
  read: {
    nullifierSpent(args: [bigint]): Promise<boolean>;
  };
}

// ── ViewingKeys subset (avoid circular dep: import only what's needed) ────────

export interface RecoverViewingKeys {
  ownerKey: bigint;
  encPriv: bigint;
}

// ── NoteStore ─────────────────────────────────────────────────────────────────

export class NoteStore {
  private storage: NoteStorage;

  constructor(storage?: NoteStorage) {
    this.storage = storage ?? new MemoryStorage();
  }

  /** Add a note (or replace if same leafIndex already stored). */
  add(note: Note): void {
    const notes = this.storage.getAll();
    if (note.leafIndex !== undefined) {
      const idx = notes.findIndex((n) => n.leafIndex === note.leafIndex);
      if (idx >= 0) {
        notes[idx] = { ...note };
      } else {
        notes.push({ ...note });
      }
    } else {
      notes.push({ ...note });
    }
    this.storage.save(notes);
  }

  /** Mark a note as spent by its leaf index. */
  markSpent(leafIndex: number): void {
    const notes = this.storage.getAll();
    const idx = notes.findIndex((n) => n.leafIndex === leafIndex);
    if (idx >= 0) {
      notes[idx] = { ...notes[idx], spent: true };
      this.storage.save(notes);
    }
  }

  /** Return all unspent notes, optionally filtered by assetId. */
  unspent(assetId?: bigint): Note[] {
    return this.storage
      .getAll()
      .filter((n) => !n.spent && (assetId === undefined || n.assetId === assetId));
  }

  /** Total balance of unspent notes for an assetId. */
  balance(assetId: bigint): bigint {
    return this.unspent(assetId).reduce((acc, n) => acc + n.amount, 0n);
  }

  /**
   * Refreshes spent status by querying pool.nullifierSpent on-chain for every
   * unspent note.
   *
   * @param pool  - pool contract with nullifierSpent readable
   * @param sk    - the user's spending key (needed to compute nullifiers)
   */
  async refreshSpent(pool: PoolReadLike, sk: bigint): Promise<void> {
    const notes = this.storage.getAll();
    let changed = false;
    for (let i = 0; i < notes.length; i++) {
      if (notes[i].spent) continue;
      const nf = computeNullifier(notes[i], sk);
      const spent = await pool.read.nullifierSpent([nf]);
      if (spent) {
        notes[i] = { ...notes[i], spent: true };
        changed = true;
      }
    }
    if (changed) this.storage.save(notes);
  }

  /**
   * Selects up to 2 unspent notes for `assetId` that together cover `amount`.
   * Prefers the combination with the fewest change (largest notes first).
   *
   * Throws "needs consolidation" if no 1-or-2-note combination is sufficient.
   */
  selectNotes(
    assetId: bigint,
    amount: bigint
  ): [Note] | [Note, Note] {
    const candidates = this.unspent(assetId).sort((a, b) =>
      a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0
    );

    // Try single note — prefer smallest note that still covers (least change).
    // Since candidates is sorted largest-first, iterate in reverse.
    let bestSingle: Note | null = null;
    for (const n of candidates) {
      if (n.amount >= amount) bestSingle = n; // keep updating; last is smallest ≥ amount
    }
    if (bestSingle !== null) return [bestSingle];

    // Try pairs (already sorted largest-first → first valid pair has least waste)
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (candidates[i].amount + candidates[j].amount >= amount) {
          return [candidates[i], candidates[j]];
        }
      }
    }

    throw new Error(
      `NoteStore: insufficient balance — needs consolidation. ` +
        `Requested ${amount}, available ${this.balance(assetId)} across ${candidates.length} note(s), ` +
        `but no 1-or-2-note combination covers the amount.`
    );
  }
}

// ── recoverWallet ─────────────────────────────────────────────────────────────

/**
 * Rebuilds a NoteStore entirely from on-chain leaf data.
 *
 * Accepts either a `LeafWithMemo[]` (already paired leaves+memos) or a
 * `SyncResult` directly (the output of `syncTree`).  In the latter case,
 * `leavesWithMemos(sync)` is called automatically so callers never have to
 * convert manually.
 *
 * @param sk      Spending key (used to compute nullifiers for refreshSpent)
 * @param vk      Viewing key pair (ownerKey + encPriv) derived from the same sk
 * @param leaves  Either `LeafWithMemo[]` or a `SyncResult` from syncTree
 * @param pool    Pool contract for nullifierSpent reads
 * @param storage Optional storage backend (default: in-memory)
 */
export async function recoverWallet(
  sk: bigint,
  vk: RecoverViewingKeys,
  leaves: LeafWithMemo[] | SyncResult,
  pool: PoolReadLike,
  storage?: NoteStorage,
): Promise<NoteStore> {
  const leafList: LeafWithMemo[] = Array.isArray(leaves)
    ? leaves
    : leavesWithMemos(leaves as SyncResult);
  const store = new NoteStore(storage);
  const notes = scanNotes(vk.ownerKey, vk.encPriv, leafList);
  for (const note of notes) store.add(note);
  await store.refreshSpent(pool, sk);
  return store;
}
