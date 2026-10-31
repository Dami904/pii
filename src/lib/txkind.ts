/**
 * src/lib/txkind.ts
 * What kind of pool call was a transaction: a deposit, a private payment (transfer) or a
 * withdrawal? Read from the first 4 bytes of the transaction's input (the function selector),
 * cached so each transaction is looked up once.
 *
 * Needed because a payment that spends a note exactly adds only ONE note to the tree, which
 * looks like a deposit from the notes alone.
 */

import { CHAIN_ID } from './pii.js'

export type TxKind = 'deposit' | 'transfer' | 'withdraw' | 'other'

// From `forge inspect PiiPool methodIdentifiers`, cross-checked against real mainnet transactions.
export const SELECTORS = {
  deposit:  '0xaa0b7db7', // deposit(uint256,uint256,bytes)
  transfer: '0x9e39edce', // transfer(bytes,(uint256 x11),address,bytes[])
  withdraw: '0x4bad2c57', // withdraw(bytes,uint256,uint256,address,uint256,uint256,address,uint256,bytes[])
} as const

export function kindFromInput(input: string): TxKind {
  const sel = input.slice(0, 10).toLowerCase()
  if (sel === SELECTORS.deposit)  return 'deposit'
  if (sel === SELECTORS.transfer) return 'transfer'
  if (sel === SELECTORS.withdraw) return 'withdraw'
  return 'other'
}

const KEY = `pii:txkind:v1:${CHAIN_ID}`
const mem = new Map<string, TxKind>()
let loaded = false

function load() {
  if (loaded) return
  loaded = true
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, TxKind>)) mem.set(k, v)
  } catch { /* unavailable: start empty */ }
}

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(mem))) } catch { /* full or blocked */ }
}

/** Anything that can read a transaction (a viem public client). */
export interface TxReader {
  getTransaction(args: { hash: `0x${string}` }): Promise<{ input: string }>
}

/** null when the lookup fails; callers then skip the transaction instead of guessing. */
export async function getTxKind(pub: TxReader, hash: string): Promise<TxKind | null> {
  load()
  const key = hash.toLowerCase()
  const hit = mem.get(key)
  if (hit) return hit
  try {
    const tx = await pub.getTransaction({ hash: hash as `0x${string}` })
    const kind = kindFromInput(tx.input)
    mem.set(key, kind)
    persist()
    return kind
  } catch {
    return null
  }
}
