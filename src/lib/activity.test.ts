/**
 * src/lib/activity.test.ts
 */

import { beforeEach, describe, expect, test } from 'bun:test'

const mem: Record<string, string> = {}
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
}

const { addActivity, loadActivity, shortAddr } = await import('./activity.js')

beforeEach(() => { for (const k of Object.keys(mem)) delete mem[k] })

describe('activity log', () => {
  test('stores newest first, amounts survive as bigint-safe strings', () => {
    addActivity(1n, { kind: 'deposit', amount: 1_500_000n, txHash: '0xaa' })
    addActivity(1n, { kind: 'pay', amount: 250_000n, counterparty: 'pii:abc' })
    const items = loadActivity(1n)
    expect(items.map((i) => i.kind)).toEqual(['pay', 'deposit'])
    expect(BigInt(items[1].amount)).toBe(1_500_000n)
  })

  test('is kept per account', () => {
    addActivity(1n, { kind: 'deposit', amount: 1n })
    expect(loadActivity(2n)).toHaveLength(0)
  })

  test('caps the log at 200 entries', () => {
    for (let i = 0; i < 205; i++) addActivity(1n, { kind: 'deposit', amount: BigInt(i) })
    expect(loadActivity(1n)).toHaveLength(200)
  })

  test('never throws on corrupt or unavailable storage', () => {
    addActivity(1n, { kind: 'deposit', amount: 1n })
    for (const key of Object.keys(mem)) mem[key] = '{not json'
    expect(loadActivity(1n)).toEqual([])
    expect(() => addActivity(1n, { kind: 'deposit', amount: 1n })).not.toThrow()
  })

  test('shortAddr leaves short values alone', () => {
    expect(shortAddr('0xabc')).toBe('0xabc')
    expect(shortAddr('pii:' + 'a'.repeat(100))).toContain('…')
  })
})
