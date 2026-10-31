/**
 * src/lib/pay-plan.ts
 * Choose the input notes for one private payment.
 *
 * The transfer circuit takes up to two input notes plus a separate fee note, so one
 * payment can combine your two largest notes. Beyond that the amount is too large for a
 * single payment. The fee note must be a different note from both inputs.
 */

import type { Note } from '@sdk/note'

export interface PaymentPlan {
  /** One or two notes the payment spends. */
  inputs:  Note[]
  /** Smallest other note that can pay the relayer fee, or null if one must be deposited. */
  feeNote: Note | null
  /** False when the relayer fee is 0: such a payment spends no fee note at all. */
  needsFeeNote: boolean
}

export type PaymentPlanResult = PaymentPlan | { error: string }

const desc = (a: Note, b: Note) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)

export function planPayment(
  notes: Note[],
  amount: bigint,
  fee: bigint,
  fmt: (a: bigint) => string,
): PaymentPlanResult {
  if (amount <= 0n) return { error: 'Enter an amount' }
  const sorted = [...notes].sort(desc)

  let inputs: Note[]
  if (sorted[0] && sorted[0].amount >= amount) {
    inputs = [sorted[0]]
  } else if (sorted.length >= 2 && sorted[0].amount + sorted[1].amount >= amount) {
    inputs = [sorted[0], sorted[1]]
  } else {
    const top2 = (sorted[0]?.amount ?? 0n) + (sorted[1]?.amount ?? 0n)
    const total = notes.reduce((s, n) => s + n.amount, 0n)
    return {
      error: total < amount
        ? `Not enough: your notes hold ${fmt(total)} USDC in total`
        : `A payment can combine your two largest notes (${fmt(top2)} USDC). Send up to that now, then the rest.`,
    }
  }

  const needsFeeNote = fee > 0n
  if (!needsFeeNote) return { inputs, feeNote: null, needsFeeNote }

  const used = new Set(inputs.map((n) => n.leafIndex))
  const feeNote = [...notes]
    .filter((n) => !used.has(n.leafIndex) && n.amount >= fee)
    .sort((a, b) => (a.amount > b.amount ? 1 : a.amount < b.amount ? -1 : 0))[0] ?? null

  return { inputs, feeNote, needsFeeNote }
}
