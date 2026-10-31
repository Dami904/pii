/**
 * src/lib/txkind.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { kindFromInput, SELECTORS } from './txkind.js'

describe('kindFromInput', () => {
  test('recognises the three pool calls by their selector (real mainnet selectors)', () => {
    expect(kindFromInput(SELECTORS.deposit + '00'.repeat(64))).toBe('deposit')
    expect(kindFromInput(SELECTORS.transfer + 'ab'.repeat(40))).toBe('transfer')
    expect(kindFromInput(SELECTORS.withdraw + '12'.repeat(40))).toBe('withdraw')
  })

  test('case does not matter, anything else is "other"', () => {
    expect(kindFromInput('0x9E39EDCE' + '00')).toBe('transfer')
    expect(kindFromInput('0xdeadbeef00')).toBe('other')
    expect(kindFromInput('0x')).toBe('other')
  })

  test('the selectors are the ones the compiled contract uses', () => {
    expect(SELECTORS).toEqual({ deposit: '0xaa0b7db7', transfer: '0x9e39edce', withdraw: '0x4bad2c57' })
  })
})
