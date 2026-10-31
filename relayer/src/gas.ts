/**
 * relayer/src/gas.ts
 * Reads the relayer's own gas balance and applies the policy in gas-policy.ts.
 * Fails OPEN: if the balance cannot be read (a flaky RPC), the request goes ahead, because
 * simulation and the on-chain call still protect against bad requests.
 */

import { account, publicClient } from "./config.js";
import { decideRelay, parseUsdcToWei, type RelayDecision, type RelayKind } from "./gas-policy.js";

/** Kept for withdrawals: payments stop when the balance would drop below this. */
export const RESERVE_WEI = parseUsdcToWei(process.env.RESERVE_USDC ?? "0.25");

export async function relayerGas(): Promise<{ balanceWei: bigint; gasPriceWei: bigint } | null> {
  try {
    const [balanceWei, gasPriceWei] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.getGasPrice(),
    ]);
    return { balanceWei, gasPriceWei };
  } catch {
    return null;
  }
}

export async function checkCanRelay(kind: RelayKind): Promise<RelayDecision> {
  const g = await relayerGas();
  if (!g) return { ok: true };
  return decideRelay(kind, g.balanceWei, g.gasPriceWei, RESERVE_WEI);
}
