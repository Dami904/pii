/**
 * src/lib/address.ts
 * Checks a Pii address against the network the app is on.
 *
 * A wallet gets a different Pii address on mainnet and on testnet (the keys come from a
 * signature that includes the chain id). Paying a testnet address on mainnet would send money
 * to keys nobody holds there, so addresses now carry their network and are checked here.
 * Older addresses without a network still work, with a warning.
 */

import { decodePiiAddress, type PiiNetwork } from '@sdk/memo'

export type AddressCheck =
  | { ok: true; decoded: ReturnType<typeof decodePiiAddress>; legacy: boolean }
  | { ok: false; kind: 'invalid' | 'wrong-network'; message: string }

export function checkAddress(addr: string, network: PiiNetwork): AddressCheck {
  let decoded: ReturnType<typeof decodePiiAddress>
  try {
    decoded = decodePiiAddress(addr.trim())
  } catch {
    return { ok: false, kind: 'invalid', message: 'Not a valid Pii address' }
  }
  if (decoded.network && decoded.network !== network) {
    return {
      ok: false,
      kind: 'wrong-network',
      message: `This is a ${decoded.network} address, but you are on ${network}. Sending to it here would lose the money.`,
    }
  }
  return { ok: true, decoded, legacy: decoded.network === undefined }
}

/** Is this address the same account? Compares the keys, not the text, so both forms match. */
export function isOwnAddress(addr: string | undefined, ownerKey: bigint): boolean {
  if (!addr) return false
  try {
    return decodePiiAddress(addr.trim()).ownerKey === ownerKey
  } catch {
    return false
  }
}
