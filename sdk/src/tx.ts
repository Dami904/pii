/**
 * sdk/src/tx.ts
 * submitAndTrack — submits a transaction and determines its outcome.
 *
 * On timeout or RPC error: does NOT report failed.
 *   - If all nullifiers are spent → "confirmed" (the tx landed somewhere)
 *   - Otherwise → "unknown" (safe to retry — nullifiers prevent double-spends)
 * On a revert receipt → "failed"
 * On success receipt → "confirmed"
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type TxOutcome = "confirmed" | "failed" | "unknown";

export interface TransactionReceipt {
  status: "success" | "reverted";
}

export interface PublicClientForTx {
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    timeout?: number;
  }): Promise<TransactionReceipt>;
}

export interface PoolNullifierReader {
  read: {
    nullifierSpent(args: [bigint]): Promise<boolean>;
  };
}

// ── submitAndTrack ────────────────────────────────────────────────────────────

/**
 * @param sendFn     - async fn that submits the tx and returns a tx hash
 * @param nullifiers - nullifiers consumed by this tx (used for fallback check)
 * @param pool       - pool contract for nullifierSpent queries
 * @param client     - public client for receipt polling
 * @param timeoutMs  - how long to wait for a receipt (default 60 000 ms)
 */
export async function submitAndTrack(
  sendFn: () => Promise<`0x${string}`>,
  nullifiers: bigint[],
  pool: PoolNullifierReader,
  client: PublicClientForTx,
  timeoutMs = 60_000
): Promise<TxOutcome> {
  let hash: `0x${string}`;

  try {
    hash = await sendFn();
  } catch {
    // sendFn threw (e.g. wallet rejected or simulated revert before broadcast)
    return "failed";
  }

  try {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: timeoutMs,
    });
    return receipt.status === "success" ? "confirmed" : "failed";
  } catch {
    // Timeout, network error, or RPC failure — check nullifiers as fallback.
    return await checkNullifiers(pool, nullifiers);
  }
}

async function checkNullifiers(
  pool: PoolNullifierReader,
  nullifiers: bigint[]
): Promise<"confirmed" | "unknown"> {
  if (nullifiers.length === 0) return "unknown";
  try {
    for (const nf of nullifiers) {
      const spent = await pool.read.nullifierSpent([nf]);
      if (!spent) return "unknown";
    }
    return "confirmed";
  } catch {
    return "unknown";
  }
}
