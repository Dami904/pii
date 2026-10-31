/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http, fallback, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { ACTIVE_CHAIN } from './lib/network.js'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(ACTIVE_CHAIN.id, ACTIVE_CHAIN.rpcUrls.default.http[0])

// Reads go straight to Arc first (each user has their own rate limit). If that fails,
// e.g. an ad blocker cancels requests to Arc's host, fall back to our read-only /api/rpc.
const arcTransport = import.meta.env.PROD
  ? fallback([http(), http(`${window.location.origin}/api/rpc`)])
  : http()

export const config = createConfig({
  chains: [ACTIVE_CHAIN, mainnet], // mainnet needed for ENS resolution
  connectors: [injected()],
  transports: {
    [ACTIVE_CHAIN.id]: arcTransport,
    [mainnet.id]: http(), // ENS resolution uses mainnet
  },
})
