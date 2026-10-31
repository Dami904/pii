/**
 * src/lib/withdraw-plan.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { planWithdraw } from './withdraw-plan.js'
import type { Note } from '@sdk/note'

const fmt = (a: bigint) => (Number(a) / 1e6).toFixed(6)
const FEE = 1000n
const note = (amount: number, leafIndex: number): Note =>
  ({ assetId: 1n, amount: BigInt(Math.round(amount * 1e6)), ownerKey: 1n, blinding: 1n, leafIndex })
const usdc = (x: number) => BigInt(Math.round(x * 1e6))
// the real notes from a tester's wallet
const NOTES = [note(2, 67), note(0.019, 69), note(3, 74), note(0.5, 89), note(0.3, 93)]

function parts(p: ReturnType<typeof planWithdraw>) {
  if ('error' in p) throw new Error(p.error)
  return p.parts
}

describe('planWithdraw', () => {
  test('one note covers it: a single withdrawal', () => {
    const p = parts(planWithdraw(NOTES, usdc(2.5), FEE, fmt))
    expect(p).toHaveLength(1)
    expect(p[0].note.leafIndex).toBe(74)
    expect(p[0].amount).toBe(usdc(2.5))
  })

  test('4.00 from notes of 3.00 and 2.00 becomes 3.00 + 1.00', () => {
    const p = parts(planWithdraw(NOTES, usdc(4), FEE, fmt))
    expect(p.map((x) => [x.note.leafIndex, x.amount])).toEqual([[74, usdc(3)], [67, usdc(1)]])
  })

  test('parts always add up to the requested amount', () => {
    for (const amt of [3.2, 4, 5, 5.3, 5.5, 5.8, 3.0005, 3.001]) {
      const p = parts(planWithdraw(NOTES, usdc(amt), FEE, fmt))
      expect(p.reduce((s, x) => s + x.amount, 0n)).toBe(usdc(amt))
      for (const x of p) {
        expect(x.amount).toBeGreaterThan(FEE)
        expect(x.amount).toBeLessThanOrEqual(x.note.amount)
      }
      expect(new Set(p.map((x) => x.note.leafIndex)).size).toBe(p.length)
    }
  })

  test('a tiny remainder (below the fee) is rebalanced instead of becoming an invalid part', () => {
    const p = parts(planWithdraw(NOTES, 3_000_500n, FEE, fmt))
    expect(p.every((x) => x.amount > FEE)).toBe(true)
  })

  test('more than the wallet holds is refused', () => {
    const p = planWithdraw(NOTES, usdc(9), FEE, fmt)
    expect('error' in p && p.error).toContain('Not enough')
  })

  test('amount at or below the fee is refused', () => {
    expect('error' in planWithdraw(NOTES, FEE, FEE, fmt)).toBe(true)
  })

  test('too many parts is refused', () => {
    const many = Array.from({ length: 8 }, (_, i) => note(1, i))
    const p = planWithdraw(many, usdc(7), FEE, fmt)
    expect('error' in p && p.error).toContain('max 5')
  })
})
