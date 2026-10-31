/**
 * src/lib/pay-parts.ts
 * Send an amount that no two notes can cover as several payments, one after another.
 *
 * One payment spends at most two notes (plus a separate fee note). A larger amount is
 * sent as a few payments to the same recipient: each takes the two largest notes the
 * wallet has right now, with a fresh chain sync in between so the next one sees the new
 * change note. The recipient ends up with a few notes that add up to the amount.
 */

import type { Hex } from 'viem'
import type { Note } from '@sdk/note'
import type { SyncResult } from '@sdk/tree'
import type { TransferCircuitInputs } from '@sdk/inputs'
import type { TransferRelayParams } from '@sdk/relayer'
import { planPayment } from './pay-plan.js'
import { prepareTransfer, FEE_NOTE_AMOUNT } from './pii-ops.js'

export const MAX_PARTS = 5

const desc = (a: Note, b: Note) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)
const capacity = (notes: Note[]) => {
  const s = [...notes].sort(desc)
  return (s[0]?.amount ?? 0n) + (s[1]?.amount ?? 0n)
}

export type PartsPlan = { parts: bigint[]; feeDeposits: number } | { error: string }

/**
 * Dry run on a copy of the notes: how many payments does this amount need?
 * Mirrors what sendInParts does (inputs are consumed, change and fee change come back).
 */
export function simulateParts(
  notes: Note[],
  amount: bigint,
  fee: bigint,
  fmt: (a: bigint) => string,
  maxParts = MAX_PARTS,
): PartsPlan {
  const total = notes.reduce((s, n) => s + n.amount, 0n)
  if (amount <= 0n) return { error: 'Enter an amount' }
  if (total < amount) return { error: `Not enough: your notes hold ${fmt(total)} USDC in total` }

  let pool: Note[] = notes.map((n) => ({ ...n }))
  let nextLeaf = -1
  let remaining = amount
  let feeDeposits = 0
  const parts: bigint[] = []

  while (remaining > 0n) {
    if (parts.length >= maxParts) {
      return { error: `This would need more than ${maxParts} payments. Send a smaller amount.` }
    }
    const cap = capacity(pool)
    if (cap <= 0n) return { error: `Not enough: your notes hold ${fmt(total)} USDC in total` }
    const send = remaining < cap ? remaining : cap

    const plan = planPayment(pool, send, fee, fmt)
    if ('error' in plan) return plan

    const spent = new Set(plan.inputs.map((n) => n.leafIndex))
    const inSum = plan.inputs.reduce((s, n) => s + n.amount, 0n)
    pool = pool.filter((n) => !spent.has(n.leafIndex))
    if (inSum > send) pool.push({ ...plan.inputs[0], amount: inSum - send, leafIndex: nextLeaf-- })

    // With a relayer fee of 0 there is no fee note: nothing is spent and nothing comes back.
    if (plan.needsFeeNote) {
      let feeNote = plan.feeNote
      if (feeNote) {
        const f = feeNote
        pool = pool.filter((n) => n.leafIndex !== f.leafIndex)
      } else {
        feeDeposits++
        feeNote = { ...plan.inputs[0], amount: FEE_NOTE_AMOUNT, leafIndex: nextLeaf-- }
      }
      if (feeNote.amount > fee) pool.push({ ...feeNote, amount: feeNote.amount - fee, leafIndex: nextLeaf-- })
    }

    parts.push(send)
    remaining -= send
  }
  return { parts, feeDeposits }
}

export interface SendDeps {
  sk:              bigint
  encPub:          Uint8Array
  recipient:       { ownerKey: bigint; encPub: Uint8Array }
  relayerAddr:     Hex
  relayerOwnerKey: bigint
  fee:             bigint
  chainId:         bigint
  fmt:             (a: bigint) => string
  prove:           (inputs: TransferCircuitInputs, onStage: (s: string) => void) => Promise<Uint8Array>
  relay:           (params: TransferRelayParams) => Promise<{ status: string; txHash?: string }>
  /** Deposit a fee note when no spare note can pay the fee; returns the fresh state. */
  topUpFee:        (inputs: Note[], notes: Note[], sr: SyncResult) => Promise<{ notes: Note[]; sr: SyncResult }>
  /** Sync until the chain read shows at least `minLeaves` leaves (also updates app state). */
  resync:          (minLeaves: number) => Promise<{ notes: Note[]; sr: SyncResult } | null>
  onPart?:         (index: number, total: number) => void
  onStatus?:       (s: 'fee-notes' | 'proving' | 'submitting') => void
  onStage?:        (s: string) => void
  onConfirmed?:    (part: { amount: bigint; txHash: string }) => void
}

export interface SendResult {
  /** Total already sent and confirmed. */
  sent:        bigint
  /** The last payment was submitted but the relayer did not confirm it in time. */
  unconfirmed: boolean
  error?:      string
  /** The last payment confirmed, but the final sync failed. */
  syncFailed?: boolean
  /** Latest known wallet state, for the caller's next step. */
  notes:       Note[]
  sr:          SyncResult
}

export async function sendInParts(
  deps: SendDeps,
  amount: bigint,
  notes0: Note[],
  sr0: SyncResult,
): Promise<SendResult> {
  let notes = notes0
  let sr = sr0
  let remaining = amount
  let sent = 0n
  let index = 0

  const sim = simulateParts(notes, amount, deps.fee, deps.fmt)
  if ('error' in sim) return { sent, unconfirmed: false, error: sim.error, notes, sr }
  const expected = sim.parts.length

  try {
    while (remaining > 0n) {
      if (index >= MAX_PARTS) {
        return { sent, unconfirmed: false, error: `Needs more than ${MAX_PARTS} payments`, notes, sr }
      }
      const cap = capacity(notes)
      const send = remaining < cap ? remaining : cap
      if (send <= 0n) return { sent, unconfirmed: false, error: 'Not enough notes', notes, sr }

      const plan = planPayment(notes, send, deps.fee, deps.fmt)
      if ('error' in plan) return { sent, unconfirmed: false, error: plan.error, notes, sr }
      let inputs = plan.inputs
      let feeNote = plan.feeNote
      deps.onPart?.(index + 1, Math.max(expected, index + 1))

      if (!feeNote && plan.needsFeeNote) {
        deps.onStatus?.('fee-notes')
        const topped = await deps.topUpFee(inputs, notes, sr)
        notes = topped.notes
        sr = topped.sr
        const used = new Set(inputs.map((n) => n.leafIndex))
        inputs = notes.filter((n) => used.has(n.leafIndex))
        feeNote = notes
          .filter((n) => !used.has(n.leafIndex) && n.amount >= deps.fee)
          .sort((x, y) => (x.amount > y.amount ? 1 : x.amount < y.amount ? -1 : 0))[0] ?? null
      }
      if ((plan.needsFeeNote && !feeNote) || inputs.length === 0) {
        return { sent, unconfirmed: false, error: 'No fee note found even after deposit. Refresh and retry.', notes, sr }
      }

      deps.onStatus?.('proving')
      const prep = prepareTransfer({
        sk:                deps.sk,
        encPub:            deps.encPub,
        inNote:            inputs[0],
        inNote2:           inputs[1],
        feeNote:           feeNote ?? undefined,
        tree:              sr.tree,
        sendAmount:        send,
        fee:               deps.fee,
        relayerAddr:       deps.relayerAddr,
        relayerOwnerKey:   deps.relayerOwnerKey,
        recipientOwnerKey: deps.recipient.ownerKey,
        recipientEncPub:   deps.recipient.encPub,
        chainId:           deps.chainId,
      })
      const proof = await deps.prove(prep.inputs, (s) => deps.onStage?.(s))
      prep.relayParams.proof = `0x${Buffer.from(proof).toString('hex')}`

      deps.onStatus?.('submitting')
      const res = await deps.relay(prep.relayParams)
      // Never count an unconfirmed payment as sent, and never continue: it may still land.
      if (res.status === 'unknown') return { sent, unconfirmed: true, notes, sr }
      if (res.status !== 'confirmed' || !res.txHash) {
        return { sent, unconfirmed: false, error: 'Transfer not confirmed.', notes, sr }
      }

      sent += send
      remaining -= send
      index++
      deps.onConfirmed?.({ amount: send, txHash: res.txHash })

      // The next payment must see this one's change note, so wait for its leaves.
      const fresh = await deps.resync(sr.leaves.length + 1)
      if (!fresh) {
        if (remaining > 0n) {
          return { sent, unconfirmed: false, error: 'Sync failed between payments', notes, sr }
        }
        return { sent, unconfirmed: false, syncFailed: true, notes, sr }
      }
      notes = fresh.notes
      sr = fresh.sr
    }
    return { sent, unconfirmed: false, notes, sr }
  } catch (e: unknown) {
    return { sent, unconfirmed: false, error: e instanceof Error ? e.message : String(e), notes, sr }
  }
}
