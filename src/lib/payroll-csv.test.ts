/**
 * src/lib/payroll-csv.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { buildSampleCsv, parseCSV } from './payroll-csv.js'
import { encodePiiAddress, deriveViewingKeys } from '@sdk/memo'
import { hash2 } from '@sdk/hash'

const SK   = 0x1234567890abcdefn
const VK   = deriveViewingKeys(SK)
const ADDR = encodePiiAddress(hash2(SK, 0n), VK.encPub)
const ADDR2 = encodePiiAddress(hash2(SK + 1n, 0n), deriveViewingKeys(SK + 1n).encPub)

describe('parseCSV', () => {
  test('the downloadable sample parses to its two valid rows', () => {
    const rows = parseCSV(buildSampleCsv(ADDR))
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => !r.error)).toBe(true)
    expect(rows.map((r) => r.amount)).toEqual([100_000n, 50_000n])
  })

  test('header optional, comments and blank lines ignored', () => {
    const rows = parseCSV(`# note\n\n${ADDR},1.5\n${ADDR2},2\n`)
    expect(rows.map((r) => r.amount)).toEqual([1_500_000n, 2_000_000n])
  })

  test('Excel UTF-8 BOM before the header does not create a bogus row', () => {
    const rows = parseCSV(`﻿pii_address,amount\r\n${ADDR},0.1\r\n`)
    expect(rows).toHaveLength(1)
    expect(rows[0].error).toBeUndefined()
  })

  test('semicolon separator with a decimal comma (European Excel)', () => {
    const rows = parseCSV(`pii_address;amount\r\n${ADDR};0,25\r\n`)
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(250_000n)
  })

  test('quoted cells are accepted', () => {
    const rows = parseCSV(`"${ADDR}","3.00"\n`)
    expect(rows[0].amount).toBe(3_000_000n)
    expect(rows[0].error).toBeUndefined()
  })

  test('bad rows are flagged, not paid', () => {
    const rows = parseCSV(`${ADDR}\nnot-an-address,1\n${ADDR},abc\n${ADDR},-5\n${ADDR},0\n`)
    expect(rows.map((r) => r.error)).toEqual([
      'Bad row', 'Invalid pii address', 'Invalid amount', 'Invalid amount', 'Invalid amount',
    ])
    expect(rows.every((r) => r.amount === 0n)).toBe(true)
  })
})

describe('parseCSV with a network', () => {
  const MAIN  = encodePiiAddress(hash2(SK, 0n), VK.encPub, 'mainnet')
  const TEST  = encodePiiAddress(hash2(SK, 0n), VK.encPub, 'testnet')

  test('a row for this network is fine and not flagged', () => {
    const r = parseCSV(`${MAIN},1`, 'mainnet')
    expect(r[0].error).toBeUndefined()
    expect(r[0].legacy).toBeUndefined()
  })

  test('a row for the other network is refused, so it can never be paid', () => {
    const r = parseCSV(`${TEST},1`, 'mainnet')
    expect(r[0].error).toBe('Wrong network (testnet address)')
    expect(r[0].amount).toBe(0n)
  })

  test('an old-format row is accepted but flagged', () => {
    const r = parseCSV(`${ADDR},1`, 'mainnet')
    expect(r[0].error).toBeUndefined()
    expect(r[0].legacy).toBe(true)
  })

  test('without a network the old behaviour is unchanged', () => {
    expect(parseCSV(`${TEST},1`)[0].error).toBeUndefined()
  })
})
