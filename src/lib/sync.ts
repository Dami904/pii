/**
 * src/lib/sync.ts
 * Pool sync with a log cache.
 *
 * Arc's RPC limits getLogs to 10k blocks, so a full scan is ~60 requests. Finished
 * chunks never change, so they are cached (memory + localStorage) and shared between
 * concurrent syncs. After the first sync a refresh only fetches the newest chunk.
 */

import { syncTree }                       from '@sdk/tree'
import seed                               from '../seed/pool-logs.json'
import type { PublicClientLike, SyncResult } from '@sdk/tree'
import { parseEventLogs, type Log } from 'viem'
import { POOL_ADDRESS, POOL_ABI, DEPLOY_BLOCK, CHAIN_ID, makePoolContractLike } from './pii.js'

type Logs = Array<{
  args: Record<string, bigint | `0x${string}` | undefined>
  blockNumber: bigint | null
  transactionHash?: `0x${string}` | null
}>

/** Where each leaf came from, so received payments can be told apart from our own change. */
export interface LeafMeta { tx: string; block: bigint }
const leafMeta = new Map<number, LeafMeta>()
export const getLeafMeta = (): ReadonlyMap<number, LeafMeta> => leafMeta

function record(logs: Logs) {
  for (const l of logs) {
    const idx = l.args['leafIndex']
    if (typeof idx === 'bigint' && l.transactionHash && l.blockNumber != null) {
      leafMeta.set(Number(idx), { tx: l.transactionHash, block: l.blockNumber })
    }
  }
}

// Chunks ending this far behind the head are treated as final.
const SAFE_DEPTH = 30n
export const STORE_KEY = `pii:logs:v3:${CHAIN_ID}:${POOL_ADDRESS.toLowerCase()}`

const memory   = new Map<string, Logs>()
const inflight = new Map<string, Promise<Logs>>()
let loaded     = false

// JSON cannot carry bigint, so tag them.
const toJson   = (_: string, v: unknown) => (typeof v === 'bigint' ? { __b: v.toString() } : v)
const fromJson = (_: string, v: unknown) =>
  (v && typeof v === 'object' && '__b' in v ? BigInt((v as { __b: string }).__b) : v)

interface Seed { chainId: number; pool: string; store: Record<string, unknown> }

function load() {
  if (loaded) return
  loaded = true
  // Bundled snapshot of finished chunks. It is public pool history, the same for every
  // wallet. syncTree still checks the rebuilt root against the pool, so a stale or wrong
  // seed fails loudly instead of being trusted; one for another pool is ignored.
  const sd = seed as Seed
  if (sd.chainId === CHAIN_ID && sd.pool.toLowerCase() === POOL_ADDRESS.toLowerCase()) {
    const parsed = JSON.parse(JSON.stringify(sd.store), fromJson) as Record<string, Logs>
    for (const [k, v] of Object.entries(parsed)) memory.set(k, v)
  }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw, fromJson) as Record<string, Logs>
    for (const [k, v] of Object.entries(parsed)) memory.set(k, v)
  } catch { /* corrupt or unavailable storage: start empty */ }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(memory), toJson))
  } catch { /* storage full or blocked: memory cache still works */ }
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms))

// Uncached requests are spaced out, and rate-limit errors are retried with backoff.
// Every finished chunk is cached, so a retry or a later sync resumes where it stopped.
let nextSlot = 0
async function fetchPaced<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, nextSlot - Date.now())
    nextSlot = Date.now() + wait + 150
    if (wait) await sleep(wait)
    try {
      return await run()
    } catch (e) {
      const msg = ((e as { shortMessage?: string }).shortMessage ?? String(e)).toLowerCase()
      if (attempt >= 6 || !/limit|429|503|fetch/.test(msg)) throw e
      await sleep(Math.min(8000, 500 * 2 ** attempt))
    }
  }
}

/** Everything cached so far (seed + fetched), in the persisted JSON shape. Used by the seed script. */
export function exportCache(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(Object.fromEntries(memory), toJson)) as Record<string, unknown>
}

function cachedClient(pub: PublicClientLike): PublicClientLike {
  load()
  let head = 0n
  return {
    async getBlockNumber() {
      head = await pub.getBlockNumber()
      return head
    },
    async getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }) {
      const key = `${args.fromBlock}-${args.toBlock}`
      const hit = memory.get(key)
      if (hit) { record(hit); return hit }
      const pending = inflight.get(key)
      if (pending) return pending

      const p = fetchPaced(() => pub.getLogs(args) as Promise<Logs>).then((full) => {
        // syncTree only reads args and blockNumber; drop the rest to keep the cache small.
        const logs = full.map((l) => ({
          args: l.args,
          blockNumber: l.blockNumber,
          transactionHash: (l as { transactionHash?: `0x${string}` | null }).transactionHash ?? null,
        }))
        record(logs)
        if (args.toBlock + SAFE_DEPTH < head) {
          memory.set(key, logs)
          persist()
        }
        return logs
      }).finally(() => { inflight.delete(key) })
      inflight.set(key, p)
      return p
    },
  }
}

/**
 * Sync the pool's Merkle tree, reusing cached log chunks.
 *
 * Arc's read servers lag a moment behind a confirmed transaction, so a sync right after
 * a send can miss the new notes. Pass `minLeaves` (the leaf count the sync must reach)
 * to wait for the chain read to catch up; it gives up after ~20s and returns what it has.
 */
export async function syncPool(pub: unknown, minLeaves = 0): Promise<SyncResult> {
  for (let attempt = 0; ; attempt++) {
    const sr = await syncTree(
      cachedClient(pub as PublicClientLike),
      makePoolContractLike(pub),
      POOL_ADDRESS,
      DEPLOY_BLOCK,
    )
    if (sr.leaves.length >= minLeaves || attempt >= 8) return sr
    await sleep(2500)
  }
}

/** Sync after a transaction, waiting until its NewCommitment leaves are visible. */
export async function syncAfterTx(pub: unknown, hash: `0x${string}`): Promise<SyncResult> {
  const client = pub as { waitForTransactionReceipt(a: { hash: `0x${string}` }): Promise<{ logs: Log[] }> }
  const receipt = await client.waitForTransactionReceipt({ hash })
  const events = parseEventLogs({ abi: POOL_ABI, logs: receipt.logs, eventName: 'NewCommitment' })
  const minLeaves = events.reduce((m, e) => Math.max(m, Number(e.args.leafIndex) + 1), 0)
  return syncPool(pub, minLeaves)
}
