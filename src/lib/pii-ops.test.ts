/**
 * src/lib/pii-ops.test.ts
 * Regression: a partial withdrawal's change note must be recoverable by its owner.
 */

import { describe, expect, test } from 'bun:test'
import { ensureFeeNotes, FEE_NOTE_AMOUNT, prepareTransfer, prepareWithdraw, USDC_ID } from './pii-ops.js'
import { commitment, randomBlinding } from '@sdk/note'
import { buildTree } from '@sdk/tree'
import { hash2, ZERO_VALUE } from '@sdk/hash'
import { deriveViewingKeys, scanNotes } from '@sdk/memo'
import type { Note } from '@sdk/note'

const SK        = 0x1234567890abcdefn
const OWNER_KEY = hash2(SK, 0n)
const VK        = deriveViewingKeys(SK)
const RELAYER   = '0x000000000000000000000000000000000000bEEF'
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'

function noteOf(amount: bigint): Note {
  return { assetId: USDC_ID, amount, ownerKey: OWNER_KEY, blinding: randomBlinding(), leafIndex: 0 }
}

function withdraw(note: Note, amount: bigint) {
  return prepareWithdraw({
    sk: SK, encPub: VK.encPub, note, tree: buildTree([commitment(note)]),
    amount, fee: 1000n, relayerAddr: RELAYER, recipient: RECIPIENT, chainId: 5042002n,
  })
}

describe('prepareWithdraw change note', () => {
  test('partial withdrawal: owner recovers the change with the right amount', () => {
    const note = noteOf(5_000_000n)
    const prep = withdraw(note, 2_000_000n)
    const found = scanNotes(OWNER_KEY, VK.encPriv, [{
      leafIndex:  1,
      commitment: BigInt(prep.relayParams.changeCommitment),
      memo:       prep.relayParams.memos[0],
    }])
    expect(found).toHaveLength(1)
    expect(found[0].amount).toBe(3_000_000n)
  })

  test('full withdrawal: no change note to recover', () => {
    const note = noteOf(5_000_000n)
    const prep = withdraw(note, 5_000_000n)
    const found = scanNotes(OWNER_KEY, VK.encPriv, [{
      leafIndex:  1,
      commitment: BigInt(prep.relayParams.changeCommitment),
      memo:       prep.relayParams.memos[0],
    }])
    expect(found).toHaveLength(0)
  })
})

describe('prepareTransfer phantom input', () => {
  test('two payments from one wallet never reuse the phantom nullifier', () => {
    const inNote  = { ...noteOf(2_000_000n), leafIndex: 0 }
    const feeNote = { ...noteOf(20_000n),    leafIndex: 1 }
    const tree    = buildTree([commitment(inNote), commitment(feeNote)])
    const pay = () => prepareTransfer({
      sk: SK, encPub: VK.encPub, inNote, feeNote, tree, sendAmount: 500_000n, fee: 1000n,
      relayerAddr: RELAYER, relayerOwnerKey: 12345n,
      recipientOwnerKey: OWNER_KEY, recipientEncPub: VK.encPub, chainId: 5042002n,
    }).relayParams.args
    const a = pay()
    const b = pay()
    expect(a.nf1).not.toBe(b.nf1)
    // and neither is the old fixed-blinding (42) nullifier
    const old = hash2(commitment({ assetId: USDC_ID, amount: 0n, ownerKey: OWNER_KEY, blinding: 42n }), SK)
    expect(BigInt(a.nf1)).not.toBe(old)
    expect(BigInt(b.nf1)).not.toBe(old)
  })
})

describe('prepareTransfer with two input notes', () => {
  test('combines two notes: change is the sum minus the amount, nullifiers are distinct', () => {
    const n1      = { ...noteOf(1_000_000n), leafIndex: 0 }
    const n2      = { ...noteOf(500_000n),   leafIndex: 1 }
    const feeNote = { ...noteOf(20_000n),    leafIndex: 2 }
    const tree    = buildTree([commitment(n1), commitment(n2), commitment(feeNote)])
    const prep = prepareTransfer({
      sk: SK, encPub: VK.encPub, inNote: n1, inNote2: n2, feeNote, tree, sendAmount: 1_200_000n, fee: 1000n,
      relayerAddr: RELAYER, relayerOwnerKey: 12345n,
      recipientOwnerKey: OWNER_KEY, recipientEncPub: VK.encPub, chainId: 5042002n,
    })
    const a = prep.relayParams.args
    expect(a.nf0).not.toBe(a.nf1)
    expect(a.nf1).not.toBe(a.nfFee)
    // the sender's change memo (slot 1) decrypts to 1.0 + 0.5 - 1.2 = 0.3
    const found = scanNotes(OWNER_KEY, VK.encPriv, [{
      leafIndex: 10, commitment: BigInt(a.outChange), memo: prep.relayParams.memos[1],
    }])
    expect(found).toHaveLength(1)
    expect(found[0].amount).toBe(300_000n)
  })
})

describe('ensureFeeNotes reports what it deposits', () => {
  const run = (notes: Note[], hashes: string[]) => ensureFeeNotes({
    notes, inNote: { ...noteOf(1_000_000n), leafIndex: 0 }, minFee: 1000n, needed: 1,
    ownerKey: OWNER_KEY, viewKeys: VK, userAddress: RELAYER as `0x${string}`,
    write: async () => hashes.shift() as `0x${string}`,
    waitReceipt: async () => {},
    readAllowance: async () => FEE_NOTE_AMOUNT,
    onDeposited: (h: `0x${string}`) => seen.push(h),
  })
  const seen: string[] = []

  test('no spare note: deposits one and reports its transaction', async () => {
    seen.length = 0
    const n = await run([{ ...noteOf(1_000_000n), leafIndex: 0 }], ['0xabc'])
    expect(n).toBe(1)
    expect(seen).toEqual(['0xabc'])
  })

  test('a spare note exists: deposits nothing and reports nothing', async () => {
    seen.length = 0
    const n = await run([{ ...noteOf(1_000_000n), leafIndex: 0 }, { ...noteOf(19_000n), leafIndex: 1 }], ['0xdef'])
    expect(n).toBe(0)
    expect(seen).toEqual([])
  })
})

describe('prepareTransfer with no fee note (relayer fee 0)', () => {
  const pay = () => {
    const inNote = { ...noteOf(1_000_000n), leafIndex: 0 }
    const tree   = buildTree([commitment(inNote)])
    return prepareTransfer({
      sk: SK, encPub: VK.encPub, inNote, tree, sendAmount: 300_000n, fee: 0n,
      relayerAddr: RELAYER, relayerOwnerKey: 12345n,
      recipientOwnerKey: OWNER_KEY, recipientEncPub: VK.encPub, chainId: 5042002n,
    })
  }

  test('creates only the recipient and change notes: the fee outputs are empty', () => {
    const a = pay().relayParams.args
    expect(BigInt(a.fee)).toBe(0n)
    expect(BigInt(a.outFee)).toBe(ZERO_VALUE)
    expect(BigInt(a.outFeeChange)).toBe(ZERO_VALUE)
    expect(BigInt(a.outRecipient)).not.toBe(ZERO_VALUE)
    expect(BigInt(a.outChange)).not.toBe(ZERO_VALUE)
  })

  test('still sends exactly four memos, and the sender recovers the 0.7 change', () => {
    const prep = pay()
    expect(prep.relayParams.memos).toHaveLength(4)
    const found = scanNotes(OWNER_KEY, VK.encPriv, [{
      leafIndex: 5, commitment: BigInt(prep.relayParams.args.outChange), memo: prep.relayParams.memos[1],
    }])
    expect(found).toHaveLength(1)
    expect(found[0].amount).toBe(700_000n)
  })

  test('the empty fee-input slot has a different nullifier every payment (no one-payment-per-wallet bug)', () => {
    const a = pay().relayParams.args
    const b = pay().relayParams.args
    expect(a.nfFee).not.toBe(b.nfFee)
    expect(a.nf1).not.toBe(b.nf1)
    expect(a.nfFee).not.toBe(a.nf0)
    expect(a.nfFee).not.toBe(a.nf1)
  })
})
