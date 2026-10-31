/**
 * src/lib/pay-plan.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { planPayment } from './pay-plan.js'
import type { Note } from '@sdk/note'

const fmt = (a: bigint) => (Number(a) / 1e6).toFixed(6)
const FEE = 1000n
const usdc = (x: number) => BigInt(Math.round(x * 1e6))
const note = (amount: number, leafIndex: number): Note =>
  ({ assetId: 1n, amount: usdc(amount), ownerKey: 1n, blinding: 1n, leafIndex })
// a real tester wallet
const NOTES = [note(2, 67), note(0.019, 69), note(3, 74), note(0.5, 89), note(0.3, 93)]

function ok(p: ReturnType<typeof planPayment>) {
  if ('error' in p) throw new Error(p.error)
  return p
}

describe('planPayment', () => {
  test('one note covers it: single input, smallest note pays the fee', () => {
    const p = ok(planPayment(NOTES, usdc(0.5), FEE, fmt))
    expect(p.inputs.map((n) => n.leafIndex)).toEqual([74])
    expect(p.feeNote?.leafIndex).toBe(69)
  })

  test('4.00 combines the 3.00 and 2.00 notes in one payment', () => {
    const p = ok(planPayment(NOTES, usdc(4), FEE, fmt))
    expect(p.inputs.map((n) => n.leafIndex)).toEqual([74, 67])
    expect(p.feeNote?.leafIndex).toBe(69)
  })

  test('exactly the sum of the two largest works; one atom more does not', () => {
    expect(ok(planPayment(NOTES, usdc(5), FEE, fmt)).inputs).toHaveLength(2)
    const p = planPayment(NOTES, usdc(5) + 1n, FEE, fmt)
    expect('error' in p && p.error).toContain('two largest notes')
  })

  test('more than the wallet holds is refused', () => {
    const p = planPayment(NOTES, usdc(9), FEE, fmt)
    expect('error' in p && p.error).toContain('Not enough')
  })

  test('the fee note is never one of the inputs; null when none is left', () => {
    const only = [note(1, 1), note(0.5, 2)]
    const p = ok(planPayment(only, usdc(1.2), FEE, fmt))
    expect(p.inputs).toHaveLength(2)
    expect(p.feeNote).toBeNull()
  })

  test('dust below the fee cannot be the fee note', () => {
    const p = ok(planPayment([note(1, 1), note(0.0005, 2)], usdc(0.5), FEE, fmt))
    expect(p.feeNote).toBeNull()
  })
})

describe('planPayment with a relayer fee of 0', () => {
  test('needs no fee note at all, even when the wallet has no spare note', () => {
    const p = ok(planPayment([note(1, 1)], usdc(0.5), 0n, fmt))
    expect(p.needsFeeNote).toBe(false)
    expect(p.feeNote).toBeNull()
    expect(p.inputs).toHaveLength(1)
  })

  test('two notes are still combined when one is not enough', () => {
    const p = ok(planPayment([note(1, 1), note(0.5, 2)], usdc(1.2), 0n, fmt))
    expect(p.inputs).toHaveLength(2)
    expect(p.needsFeeNote).toBe(false)
  })

  test('with a fee, the old behaviour is unchanged', () => {
    expect(ok(planPayment(NOTES, usdc(0.5), 1000n, fmt)).needsFeeNote).toBe(true)
  })
})
