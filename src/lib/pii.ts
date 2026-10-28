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
  { name: 'currentPoolBalance', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
  { name: 'nullifierSpent',   type: 'function', stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'NewCommitment',    type: 'event',
    inputs: [
      { name: 'leafIndex',  type: 'uint256', indexed: true  },
      { name: 'commitment', type: 'uint256', indexed: false },
      { name: 'memo',       type: 'bytes',   indexed: false },
    ] },
] as const

export const REGISTRY_ABI = [
  { name: 'register', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'ownerKey', type: 'uint256' },
      { name: 'encPub',   type: 'bytes'   },
    ], outputs: [] },
  { name: 'encPubOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'ownerKey', type: 'uint256' }], outputs: [{ type: 'bytes' }] },
  { name: 'KeyRegistered', type: 'event',
    inputs: [
      { name: 'ownerKey', type: 'uint256', indexed: true  },
      { name: 'encPub',   type: 'bytes',   indexed: false },
    ] },
] as const

/** Format a USDC atom amount to a 2-decimal string (e.g. 1500000 → "1.50") */
export function formatUsdc(atoms: bigint): string {
  const s = atoms.toString().padStart(7, '0')
  return `${s.slice(0, -6) || '0'}.${s.slice(-6, -4)}`
}

/** Parse a decimal USDC string to atoms (e.g. "1.50" → 1500000n) */
export function parseUsdc(s: string): bigint {
  const [int, frac = ''] = s.split('.')
  const padded = frac.padEnd(6, '0').slice(0, 6)
  return BigInt(int || '0') * 1_000_000n + BigInt(padded)
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

