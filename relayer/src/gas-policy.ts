/**
 * relayer/src/gas-policy.ts
 * Pure rules for when the relayer may spend its own gas. No I/O, so it is unit-tested.
 *
 * The relayer pays gas for every payment and withdrawal it relays, and in this version it
 * earns nothing back. Two things protect it (and the users who depend on it):
 *  - an operation is refused if the wallet cannot afford it, so nothing fails half-way;
 *  - a RESERVE is kept for withdrawals: payments stop first, so people can always get out.
 */

export type RelayKind = "transfer" | "withdraw";

/** Typical gas per operation, measured on Arc mainnet. Transfers use less without a fee note. */
export const TYPICAL_GAS = {
  transfer: 6_300_000n,
  transferNoFee: 4_700_000n,
  withdraw: 3_800_000n,
} as const;

const E18 = 10n ** 18n;

/** "0.25" -> wei (Arc's native USDC has 18 decimals). */
export function parseUsdcToWei(s: string): bigint {
  const [i, f = ""] = s.trim().split(".");
  return BigInt(i || "0") * E18 + BigInt(f.padEnd(18, "0").slice(0, 18) || "0");
}

/** Worst-case cost of one operation: typical gas x price, plus a 20% margin. */
export function opCostWei(kind: RelayKind, gasPriceWei: bigint): bigint {
  const gas = kind === "transfer" ? TYPICAL_GAS.transfer : TYPICAL_GAS.withdraw;
  return (gas * gasPriceWei * 12n) / 10n;
}

export type RelayDecision = { ok: true } | { ok: false; message: string };

export function decideRelay(
  kind: RelayKind,
  balanceWei: bigint,
  gasPriceWei: bigint,
  reserveWei: bigint,
): RelayDecision {
  const cost = opCostWei(kind, gasPriceWei);
  // Payments must leave the reserve untouched; withdrawals may use it.
  const needed = kind === "transfer" ? cost + reserveWei : cost;
  if (balanceWei >= needed) return { ok: true };
  return {
    ok: false,
    message:
      kind === "transfer"
        ? "The relayer is low on gas and is only relaying withdrawals right now. Please try again later."
        : "The relayer is out of gas. Please try again later.",
  };
}
