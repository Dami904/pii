/**
 * src/lib/received.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { describeNotes, findReceived, findReceivedSingles } from './received.js'
import type { TxKind } from './txkind.js'

const meta = (rows: Array<[number, string]>) =>
  new Map(rows.map(([leaf, tx]) => [leaf, { tx, block: 100n }]))
const own = (...leaves: number[]) => leaves.map((leafIndex) => ({ leafIndex, amount: 500_000n }))

// 4 outputs per transfer: recipient, change, fee, fee change
const transfer = (tx: string, first: number): Array<[number, string]> =>
  [0, 1, 2, 3].map((i) => [first + i, tx])

describe('findReceived', () => {
  test('owning only the recipient (first) note of a transfer = received', () => {
    const r = findReceived(own(20), meta(transfer('0xB', 20)))
    expect(r).toHaveLength(1)
    expect(r[0].leafIndex).toBe(20)
    expect(r[0].tx).toBe('0xB')
  })

  test('our own payment (we hold change and fee change) is not received', () => {
    expect(findReceived(own(11, 13), meta(transfer('0xA', 10)))).toHaveLength(0)
  })

  test('paying ourselves (we own recipient + change + fee change) is not received', () => {
    expect(findReceived(own(40, 41, 43), meta(transfer('0xC', 40)))).toHaveLength(0)
  })

  test('single-note transactions (deposit, withdrawal change) are not received', () => {
    expect(findReceived(own(30), meta([[30, '0xD']]))).toHaveLength(0)
  })

  test('notes with unknown provenance are skipped, not guessed', () => {
    expect(findReceived(own(99), meta(transfer('0xB', 20)))).toHaveLength(0)
  })

  test('several received payments are all found', () => {
    const m = meta([...transfer('0xB', 20), ...transfer('0xE', 50)])
    expect(findReceived(own(20, 50), m).map((x) => x.leafIndex).sort()).toEqual([20, 50])
  })
})

describe('describeNotes', () => {
  test('labels each owned note by where it came from', () => {
    // tx 0xA: 10..13, we paid someone else, keep change (11) and fee change (13)
    // tx 0xB: 20..23, someone paid us (20)
    // tx 0xC: 40..43, we paid ourselves (40 recipient + 41 change + 43 fee change)
    // tx 0xD: single note 30 (deposit or withdrawal change)
    const m = meta([...transfer('0xA', 10), ...transfer('0xB', 20), ...transfer('0xC', 40), [30, '0xD']])
    const d = describeNotes(own(11, 13, 20, 30, 40, 41, 43), m)
    expect(d.get(11)?.origin).toBe('change')
    expect(d.get(13)?.origin).toBe('change')
    expect(d.get(20)?.origin).toBe('received')
    expect(d.get(30)?.origin).toBe('single')
    expect(d.get(40)?.origin).toBe('self')
    expect(d.get(41)?.origin).toBe('change')
    expect(d.get(43)?.origin).toBe('change')
  })

  test('a note whose transaction is unknown is left unlabelled', () => {
    expect(describeNotes(own(99), meta(transfer('0xB', 20))).has(99)).toBe(false)
  })

  test('carries the transaction and block for the time lookup', () => {
    const d = describeNotes(own(20), meta(transfer('0xB', 20)))
    expect(d.get(20)?.tx).toBe('0xB')
    expect(d.get(20)?.block).toBe(100n)
  })
})

describe('findReceivedSingles (a payment that adds only one note)', () => {
  const kinds = (m: Record<string, TxKind | null>) => async (tx: string) => m[tx] ?? null
  const none = new Set<string>()

  test('a single-note transfer to us is received', async () => {
    const r = await findReceivedSingles(own(7), meta([[7, '0xT']]), kinds({ '0xT': 'transfer' }), none)
    expect(r.map((x) => x.leafIndex)).toEqual([7])
  })

  test('a single-note deposit or withdrawal change is NOT received', async () => {
    const m = meta([[1, '0xD'], [2, '0xW']])
    const r = await findReceivedSingles(own(1, 2), m, kinds({ '0xD': 'deposit', '0xW': 'withdraw' }), none)
    expect(r).toHaveLength(0)
  })

  test('a payment this device sent to its own address is not income', async () => {
    const r = await findReceivedSingles(own(7), meta([[7, '0xT']]), kinds({ '0xT': 'transfer' }), new Set(['0xt']))
    expect(r).toHaveLength(0)
  })

  test('when the lookup fails the note is skipped, not guessed', async () => {
    const r = await findReceivedSingles(own(7), meta([[7, '0xT']]), kinds({}), none)
    expect(r).toHaveLength(0)
  })

  test('notes inside multi-note transactions are left to findReceived', async () => {
    const r = await findReceivedSingles(own(20), meta(transfer('0xB', 20)), kinds({ '0xB': 'transfer' }), none)
    expect(r).toHaveLength(0)
  })
})
