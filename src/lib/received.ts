/**
 * src/lib/received.ts
 * Tell where each of the user's notes came from, from the chain alone.
 *
 * A transfer inserts its outputs in a fixed order: recipient first, then the sender's
 * change and fee notes. So in a multi-note transaction:
 *   - owning the first note and none of the others means someone else paid us (received);
 *   - owning the first note and others means we paid ourselves (our change came back too);
 *   - owning a later note is our own change.
 * A transaction with a single note is a deposit or a withdrawal's change; the chain cannot
 * tell those two apart.
 */

import type { Note } from '@sdk/note'
import type { LeafMeta } from './sync.js'
import type { TxKind } from './txkind.js'

export type NoteOrigin = 'received' | 'self' | 'change' | 'single'

export interface NoteInfo {
  origin: NoteOrigin
  tx:     string
  block:  bigint
}

export interface ReceivedPayment {
  leafIndex: number
  amount:    bigint
  tx:        string
  block:     bigint
}

/** Origin of every owned note whose transaction is known. Notes with unknown provenance are left out. */
export function describeNotes(
  owned: Pick<Note, 'leafIndex' | 'amount'>[],
  meta: ReadonlyMap<number, LeafMeta>,
): Map<number, NoteInfo> {
  const byTx = new Map<string, number[]>()
  for (const [leaf, m] of meta) byTx.set(m.tx, [...(byTx.get(m.tx) ?? []), leaf])

  const ownedLeaves = new Set(owned.map((n) => n.leafIndex))
  const out = new Map<number, NoteInfo>()
  for (const n of owned) {
    if (n.leafIndex === undefined) continue
    const m = meta.get(n.leafIndex)
    if (!m) continue
    const group = (byTx.get(m.tx) ?? []).sort((a, b) => a - b)
    let origin: NoteOrigin
    if (group.length < 2) origin = 'single'
    else if (group[0] !== n.leafIndex) origin = 'change'
    else origin = group.every((l) => l === n.leafIndex || !ownedLeaves.has(l)) ? 'received' : 'self'
    out.set(n.leafIndex, { origin, tx: m.tx, block: m.block })
  }
  return out
}

export function findReceived(
  owned: Pick<Note, 'leafIndex' | 'amount'>[],
  meta: ReadonlyMap<number, LeafMeta>,
): ReceivedPayment[] {
  const info = describeNotes(owned, meta)
  const out: ReceivedPayment[] = []
  for (const n of owned) {
    const d = n.leafIndex === undefined ? undefined : info.get(n.leafIndex)
    if (n.leafIndex !== undefined && d?.origin === 'received') {
      out.push({ leafIndex: n.leafIndex, amount: n.amount, tx: d.tx, block: d.block })
    }
  }
  return out
}

/**
 * A payment that spends a note exactly (and charges no fee) adds a single note to the tree,
 * which `findReceived` cannot tell from a deposit. For each owned single-note transaction,
 * ask what the transaction really was; a transfer means someone paid us.
 *
 * `sentTxs` are transactions this device sent itself (lower-case hashes): a payment to your
 * own address is not income, so it is skipped.
 */
export async function findReceivedSingles(
  owned: Pick<Note, 'leafIndex' | 'amount'>[],
  meta: ReadonlyMap<number, LeafMeta>,
  kindOf: (tx: string) => Promise<TxKind | null>,
  sentTxs: ReadonlySet<string>,
): Promise<ReceivedPayment[]> {
  const info = describeNotes(owned, meta)
  const out: ReceivedPayment[] = []
  for (const n of owned) {
    const d = n.leafIndex === undefined ? undefined : info.get(n.leafIndex)
    if (n.leafIndex === undefined || !d || d.origin !== 'single') continue
    if (sentTxs.has(d.tx.toLowerCase())) continue
    if ((await kindOf(d.tx)) !== 'transfer') continue
    out.push({ leafIndex: n.leafIndex, amount: n.amount, tx: d.tx, block: d.block })
  }
  return out
}
