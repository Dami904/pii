/**
 * src/lib/pii.ts
 * Contract addresses, ABIs, and constants shared across the frontend.
 */

import { DEPLOYMENT } from './network.js'
import type { Hex } from 'viem'
import type { PoolReadLike }    from '@sdk/wallet'
import type { PoolContractLike } from '@sdk/tree'

export const CHAIN_ID      = DEPLOYMENT.chainId
export const DEPLOY_BLOCK  = BigInt(DEPLOYMENT.deployBlock)
export const EXPLORER      = DEPLOYMENT.explorer

export const POOL_ADDRESS     = DEPLOYMENT.contracts.PiiPool.address as Hex
export const REGISTRY_ADDRESS = DEPLOYMENT.contracts.PiiKeyRegistry.address as Hex
export const USDC_ADDRESS     = DEPLOYMENT.usdc as Hex

/** Relay endpoint — /api/relay in production (Vercel), /relay in local dev (Vite proxy) */
export const RELAY_BASE: string = (import.meta.env.VITE_RELAY_BASE as string | undefined) ?? '/api/relay'

// ── ABIs (minimal fragments needed by the UI) ────────────────────────────────

export const USDC_ABI = [
  { name: 'balanceOf',  type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'allowance',  type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ type: 'uint256' }] },
  { name: 'approve',    type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
  { name: 'transfer',   type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ type: 'bool' }] },
] as const

export const POOL_ABI = [
  { name: 'deposit',          type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'secret', type: 'uint256' },
      { name: 'memo',   type: 'bytes'   },
    ], outputs: [] },
  { name: 'maxDeposit',       type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'maxPoolBalance',   type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'nullifierSpent',   type: 'function', stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  // Public mapping on PiiMerkle; syncTree refuses any root the pool does not know.
  { name: 'isKnownRoot',      type: 'function', stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'NewCommitment',    type: 'event',
    inputs: [
      { name: 'leafIndex',  type: 'uint256', indexed: true  },
      { name: 'commitment', type: 'uint256', indexed: false },
      { name: 'memo',       type: 'bytes',   indexed: false },
    ] },
] as const

// Matches contracts/src/PiiKeyRegistry.sol
export const REGISTRY_ABI = [
  { name: 'register', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'encPub', type: 'bytes' }], outputs: [] },
  { name: 'getKey', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'bytes' }] },
  { name: 'KeyRegistered', type: 'event',
    inputs: [
      { name: 'owner',  type: 'address', indexed: true  },
      { name: 'encPub', type: 'bytes',   indexed: false },
    ] },
] as const

/** Format USDC atoms: min 2 decimals, up to 6 (e.g. 1500000 → "1.50", 1000 → "0.001") */
export function formatUsdc(atoms: bigint): string {
  const s = atoms.toString().padStart(7, '0')
  // At least 2 decimals, up to 6 when needed: 1500000 -> "1.50", 1000 -> "0.001"
  const frac = s.slice(-6).replace(/0+$/, '').padEnd(2, '0')
  return `${s.slice(0, -6)}.${frac}`
}

/** Parse a decimal USDC string to atoms (e.g. "1.50" → 1500000n) */
/**
 * Parse a USDC string to atoms. Returns 0n for anything that is not a plain
 * non-negative decimal with at most 6 places ("1e5", "-1", "abc", "1.2345678"),
 * so callers treat it as "no amount" instead of BigInt throwing during render.
 */
export function parseUsdc(s: string): bigint {
  const t = s.trim()
  if (!/^\d*(\.\d{0,6})?$/.test(t)) return 0n
  const [int, frac = ''] = t.split('.')
  return BigInt(int || '0') * 1_000_000n + BigInt(frac.padEnd(6, '0'))
}

export function explorerTx(hash: string)  { return `${EXPLORER}/tx/${hash}` }
export function explorerAddr(addr: string){ return `${EXPLORER}/address/${addr}` }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makePoolLike(pub: any): PoolReadLike {
  return {
    read: {
      nullifierSpent: (args) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        pub.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'nullifierSpent', args }) as Promise<boolean>,
    },
  }
}

export type { PoolReadLike }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makePoolContractLike(pub: any): PoolContractLike {
  return {
    read: {
      isKnownRoot: (args) =>
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        pub.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'isKnownRoot', args }) as Promise<boolean>,
    },
  }
}

export type { PoolContractLike }

