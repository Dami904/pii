/**
 * src/lib/relayer-gas.ts
 * How much more the relayer can do, from the gas wallet it reports in /info.
 * Mirrors relayer/src/gas-policy.ts: a payment needs its cost plus the reserve, a withdrawal
 * only its cost. Amounts from the relayer are wei (18 decimals).
 */

import type { RelayerInfo } from '@sdk/relayer'

export interface RelayerCapacity {
  /** How many more payments the relayer will accept. */
  transfersLeft:    number
  /** How many more withdrawals it can relay (it may spend its reserve on these). */
  withdrawalsLeft:  number
  /** What one payment costs the relayer in gas, in USDC (with the safety margin). */
  transferCostUsdc: number
  /** True when only a few payments are left, worth warning about. */
  low:              boolean
}

const LOW_AT = 3

/** null when the relayer does not report its balance (older relayer): nothing to check. */
export function relayerCapacity(info: RelayerInfo | null, noFee: boolean): RelayerCapacity | null {
  const g = info?.gas
  if (!g) return null
  const balance = BigInt(g.balanceWei)
  const price   = BigInt(g.gasPriceWei)
  const reserve = BigInt(g.reserveWei)
  const transferCost = (BigInt(noFee ? g.typicalGas.transferNoFee : g.typicalGas.transfer) * price * 12n) / 10n
  const withdrawCost = (BigInt(g.typicalGas.withdraw) * price * 12n) / 10n
  if (transferCost <= 0n || withdrawCost <= 0n) return null

  const transfersLeft   = balance > reserve ? Number((balance - reserve) / transferCost) : 0
  const withdrawalsLeft = Number(balance / withdrawCost)
  return {
    transfersLeft,
    withdrawalsLeft,
    transferCostUsdc: Number(transferCost) / 1e18,
    low: transfersLeft <= LOW_AT,
  }
}
