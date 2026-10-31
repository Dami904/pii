/**
 * src/lib/address.test.ts
 */

import { describe, expect, test } from 'bun:test'
import { checkAddress, isOwnAddress } from './address.js'
import { deriveViewingKeys, encodePiiAddress } from '@sdk/memo'
import { hash2 } from '@sdk/hash'

const SK    = 0x1234567890abcdefn
const OWNER = hash2(SK, 0n)
const ENC   = deriveViewingKeys(SK).encPub

const mainnet = encodePiiAddress(OWNER, ENC, 'mainnet')
const testnet = encodePiiAddress(OWNER, ENC, 'testnet')
const legacy  = encodePiiAddress(OWNER, ENC)

describe('checkAddress', () => {
  test('an address for this network is accepted, without a warning', () => {
    const c = checkAddress(mainnet, 'mainnet')
    expect(c.ok && !c.legacy).toBe(true)
  })

  test('an address for the OTHER network is refused, with a clear message', () => {
    const c = checkAddress(testnet, 'mainnet')
    expect(c.ok).toBe(false)
    expect(!c.ok && c.kind).toBe('wrong-network')
    expect(!c.ok && c.message).toContain('testnet address')
    expect(!c.ok && c.message).toContain('lose the money')
    const d = checkAddress(mainnet, 'testnet')
    expect(!d.ok && d.kind).toBe('wrong-network')
  })

  test('an old address with no network is accepted but flagged as legacy', () => {
    for (const net of ['mainnet', 'testnet'] as const) {
      const c = checkAddress(legacy, net)
      expect(c.ok && c.legacy).toBe(true)
    }
  })

  test('surrounding spaces are tolerated, garbage is invalid', () => {
    expect(checkAddress('  ' + mainnet + '\n', 'mainnet').ok).toBe(true)
    const bad = checkAddress('pii:nope', 'mainnet')
    expect(!bad.ok && bad.kind).toBe('invalid')
  })
})

describe('isOwnAddress', () => {
  test('matches every form of the same account, not just the same text', () => {
    expect(isOwnAddress(mainnet, OWNER)).toBe(true)
    expect(isOwnAddress(testnet, OWNER)).toBe(true)
    expect(isOwnAddress(legacy, OWNER)).toBe(true)
  })

  test('a different account, junk or nothing is not own', () => {
    const other = encodePiiAddress(hash2(SK + 1n, 0n), deriveViewingKeys(SK + 1n).encPub, 'mainnet')
    expect(isOwnAddress(other, OWNER)).toBe(false)
    expect(isOwnAddress('junk', OWNER)).toBe(false)
    expect(isOwnAddress(undefined, OWNER)).toBe(false)
  })
})
