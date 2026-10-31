/**
 * src/lib/pay-parts.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { simulateParts } from './pay-parts.js'
import type { Note } from '@sdk/note'

const fmt = (a: bigint) => (Number(a) / 1e6).toFixed(6)
const FEE = 1000n
const usdc = (x: number) => BigInt(Math.round(x * 1e6))
const note = (amount: number, leafIndex: number): Note =>
  ({ assetId: 1n, amount: usdc(amount), ownerKey: 1n, blinding: 1n, leafIndex })

// the tester wallet that hit the limit trying to send 7
const NOTES = [note(0.2, 94), note(0.498, 96), note(2, 107), note(4, 108), note(2.1, 109), note(2.5, 113)]

function parts(p: ReturnType<typeof simulateParts>) {
  if ('error' in p) throw new Error(p.error)
  return p
}

describe('simulateParts', () => {
  test('7.00 from that wallet is two payments: 6.50 then 0.50', () => {
    const p = parts(simulateParts(NOTES, usdc(7), FEE, fmt))
    expect(p.parts).toEqual([usdc(6.5), usdc(0.5)])
    expect(p.feeDeposits).toBe(0)
  })

  test('anything up to the two largest notes is one payment', () => {
    expect(parts(simulateParts(NOTES, usdc(6.5), FEE, fmt)).parts).toEqual([usdc(6.5)])
    expect(parts(simulateParts(NOTES, usdc(0.3), FEE, fmt)).parts).toEqual([usdc(0.3)])
  })

  test('parts always add up to the amount and none is empty', () => {
    for (const amt of [6.6, 7, 8, 9.5, 10.6]) {
      const p = parts(simulateParts(NOTES, usdc(amt), FEE, fmt))
      expect(p.parts.reduce((s, x) => s + x, 0n)).toBe(usdc(amt))
      expect(p.parts.every((x) => x > 0n)).toBe(true)
      expect(p.parts.length).toBeLessThanOrEqual(5)
    }
  })

  test('more than the wallet holds is refused', () => {
    const p = simulateParts(NOTES, usdc(20), FEE, fmt)
    expect('error' in p && p.error).toContain('Not enough')
  })

  test('too many payments is refused', () => {
    const many = Array.from({ length: 14 }, (_, i) => note(1, i))
    const p = simulateParts(many, usdc(12), FEE, fmt)
    expect('error' in p && p.error).toContain('more than 5')
  })

  test('with no spare note for the fee, a fee note deposit is counted', () => {
    const p = parts(simulateParts([note(1, 1), note(0.5, 2)], usdc(1.2), FEE, fmt))
    expect(p.parts).toEqual([usdc(1.2)])
    expect(p.feeDeposits).toBe(1)
  })
})

describe('simulateParts with a relayer fee of 0', () => {
  test('same payments as before, and never a fee-note deposit', () => {
    const p = parts(simulateParts(NOTES, usdc(7), 0n, fmt))
    expect(p.parts).toEqual([usdc(6.5), usdc(0.5)])
    expect(p.feeDeposits).toBe(0)
  })

  test('a wallet with exactly two notes and no spare can pay without any setup deposit', () => {
    const p = parts(simulateParts([note(1, 1), note(0.5, 2)], usdc(1.2), 0n, fmt))
    expect(p.parts).toEqual([usdc(1.2)])
    expect(p.feeDeposits).toBe(0)
  })
})
