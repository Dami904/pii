/**
 * src/lib/relayer-gas.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { relayerCapacity } from './relayer-gas.js'
import type { RelayerInfo } from '@sdk/relayer'

const wei = (usdc: number) => BigInt(Math.round(usdc * 1e6)) * 10n ** 12n
const info = (balance: number): RelayerInfo => ({
  relayerAddress: '0x0000000000000000000000000000000000000001',
  relayerOwnerKey: '0x01',
  minFee: '0',
  chainId: 5042,
  pool: '0x0000000000000000000000000000000000000002',
  gas: {
    balanceWei:  wei(balance).toString(),
    gasPriceWei: (20n * 10n ** 9n).toString(),
    reserveWei:  wei(0.25).toString(),
    typicalGas:  { transfer: '6300000', transferNoFee: '4700000', withdraw: '3800000' },
  },
})

describe('relayerCapacity', () => {
  test('older relayer without a gas report: nothing to check', () => {
    expect(relayerCapacity({ ...info(1), gas: undefined }, true)).toBeNull()
    expect(relayerCapacity(null, true)).toBeNull()
  })

  test('about 1 USDC: several payments, more withdrawals, not low', () => {
    const c = relayerCapacity(info(1), true)!
    expect(c.transfersLeft).toBe(6) // (1 - 0.25) / 0.113
    expect(c.withdrawalsLeft).toBeGreaterThan(c.transfersLeft)
    expect(c.low).toBe(false)
  })

  test('without a fee note a payment is cheaper, so more fit', () => {
    expect(relayerCapacity(info(1), true)!.transfersLeft).toBeGreaterThan(relayerCapacity(info(1), false)!.transfersLeft)
  })

  test('at or below the reserve: no payments, but withdrawals remain', () => {
    const c = relayerCapacity(info(0.25), true)!
    expect(c.transfersLeft).toBe(0)
    expect(c.withdrawalsLeft).toBeGreaterThanOrEqual(1)
    expect(c.low).toBe(true)
  })

  test('the cost of one payment is reported in USDC', () => {
    expect(relayerCapacity(info(1), true)!.transferCostUsdc).toBeCloseTo(0.1128, 3)
  })
})
