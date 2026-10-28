/**
 * src/lib/network.ts
 *
 * Reads VITE_NETWORK (testnet | mainnet) and exports the active deployment
 * record and viem chain. Defaults to testnet.
 */

import testnetDeployment from '../../deployments/arc-testnet.json'
import mainnetDeployment from '../../deployments/arc-mainnet.json'
import { arcTestnet }    from 'viem/chains'
import type { Chain }    from 'viem'

const arcMainnet = {
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls:        { default: { http: ['https://rpc.mainnet.arc.io'] } },
  blockExplorers: { default: { name: 'Arc Explorer', url: 'https://explorer.arc.io' } },
} as const satisfies Chain

export type NetworkId = 'testnet' | 'mainnet'

/** The active network, resolved at build time from VITE_NETWORK. */
export const NETWORK: NetworkId =
  import.meta.env.VITE_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'

export const IS_MAINNET = NETWORK === 'mainnet'

/** Active viem chain */
export const ACTIVE_CHAIN: Chain = IS_MAINNET ? arcMainnet : arcTestnet

/** Active deployment record */
export const DEPLOYMENT = IS_MAINNET
  ? (mainnetDeployment as typeof testnetDeployment)
  : testnetDeployment
