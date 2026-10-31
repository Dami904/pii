/**
 * src/lib/withdraw-plan.ts
 * Split a withdrawal across notes. The circuit spends one note per withdrawal, so an
 * amount larger than any single note becomes several withdrawals, one after another.
 * Each part's amount includes the relayer fee, so each part must exceed the fee.
 */

import type { Note } from '@sdk/note'

export interface WithdrawPart { note: Note; amount: bigint }
export type WithdrawPlan = { parts: WithdrawPart[] } | { error: string }

export const MAX_PARTS = 5

export function planWithdraw(
  notes: Note[],
  amount: bigint,
  fee: bigint,
  fmt: (a: bigint) => string,
  maxParts = MAX_PARTS,
): WithdrawPlan {
  if (amount <= fee) return { error: `Amount must be more than the ${fmt(fee)} USDC fee` }

  const sorted = [...notes].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))

  // One note is enough: a single withdrawal.
  const single = sorted.find((n) => n.amount >= amount)
  if (single) return { parts: [{ note: single, amount }] }

  const total = notes.reduce((s, n) => s + n.amount, 0n)
  if (total < amount) return { error: `Not enough: your notes hold ${fmt(total)} USDC in total` }

  // Several notes: take whole notes largest-first, the last one partially.
  const parts: WithdrawPart[] = []
  let remaining = amount
  for (const n of sorted) {
    if (remaining === 0n) break
    if (n.amount <= fee) continue // dust: cannot cover its own fee
    let take = n.amount < remaining ? n.amount : remaining
    // Never leave a remainder that is too small to be a withdrawal of its own.
    if (remaining - take > 0n && remaining - take <= fee) take = remaining - fee - 1n
    if (take <= fee) continue
    parts.push({ note: n, amount: take })
    remaining -= take
  }
  if (remaining > 0n) return { error: 'This exact amount cannot be made from your notes. Try a different amount.' }
  if (parts.length > maxParts) {
    return { error: `This would need ${parts.length} withdrawals (max ${maxParts}). Withdraw a smaller amount.` }
  }
  return { parts }
}
