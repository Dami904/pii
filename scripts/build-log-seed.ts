/**
 * scripts/build-log-seed.ts
 * Snapshot the pool's finished NewCommitment log chunks into src/seed/pool-logs.json,
 * so a first-time visitor does not have to scan the whole history through the RPC.
 *
 * Run before deploying, for the active network:
 *   VITE_NETWORK=testnet bun run scripts/build-log-seed.ts
 * It is public chain data. The app re-validates the rebuilt tree root against the pool.
 */

import { writeFileSync } from 'node:fs'
import { createPublicClient, http } from 'viem'
import { ACTIVE_CHAIN } from '../src/lib/network.js'
import { CHAIN_ID, POOL_ADDRESS } from '../src/lib/pii.js'

const mem: Record<string, string> = {}
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => { mem[k] = v },
}

// Imported after the storage shim exists, because sync.ts reads it.
const { syncPool, exportCache } = await import('../src/lib/sync.js')

const rpc = process.env.RPC_URL ?? ACTIVE_CHAIN.rpcUrls.default.http[0]
const pub = createPublicClient({ transport: http(rpc, { retryCount: 0 }) })

const sr = await syncPool(pub)
const store = exportCache()
if (Object.keys(store).length === 0) {
  throw new Error('no finished chunks to write; refusing to overwrite the seed with an empty one')
}

writeFileSync(
  new URL('../src/seed/pool-logs.json', import.meta.url),
  JSON.stringify({ chainId: CHAIN_ID, pool: POOL_ADDRESS, store }) + '\n',
)
console.log(`seed written: ${Object.keys(store).length} chunks, ${sr.leaves.length} leaves, chain ${CHAIN_ID}`)
