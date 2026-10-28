/**
 * sdk/src/relayer.ts
 * Client-side helpers for interacting with the Pii relayer service.
 *
 * selfRelay fallback: the user's browser wallet submits the tx directly,
 * with a console warning that this links their EOA address.
 */

import type { TxOutcome } from "./tx.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface RelayerInfo {
  relayerAddress: `0x${string}`;
  relayerOwnerKey: `0x${string}`;
  minFee: string;
  chainId: number;
  pool: `0x${string}`;
}

export interface RelayResult {
  txHash: `0x${string}`;
  status: TxOutcome;
}

export interface WithdrawRelayParams {
  proof: `0x${string}`;
  root: string;
  nullifier: string;
  recipient: `0x${string}`;
  amount: string;
  changeCommitment: string;
  relayer: `0x${string}`;
  fee: string;
  memos: `0x${string}`[];
  chainId: number;
  pool: `0x${string}`;
}

export interface TransferRelayParams {
  proof: `0x${string}`;
  args: {
    root: string;
    nf0: string;
    nf1: string;
    nfFee: string;
    outRecipient: string;
    outChange: string;
    outFee: string;
    outFeeChange: string;
    eligibilityRoot: string;
    fee: string;
    relayerOwnerKey: string;
  };
  relayer: `0x${string}`;
  memos: `0x${string}`[];
  chainId: number;
  pool: `0x${string}`;
}

// ── API ────────────────────────────────────────────────────────────────────

/**
 * Fetch relayer info: address, owner key, minFee, chainId, pool.
 */
export async function getRelayerInfo(url: string): Promise<RelayerInfo> {
  const res = await fetch(`${url}/info`);
  if (!res.ok) throw new Error(`relayer /info failed: ${res.status}`);
  return res.json() as Promise<RelayerInfo>;
}

/**
 * Relay a withdraw tx through the relayer service.
 */
export async function relayWithdraw(
  url: string,
  params: WithdrawRelayParams,
): Promise<RelayResult> {
  const res = await fetch(`${url}/relay/withdraw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`relayWithdraw failed ${res.status}: ${(body as { error: string }).error}`);
  }
  return res.json() as Promise<RelayResult>;
}

/**
 * Relay a transfer tx through the relayer service.
 */
export async function relayTransfer(
  url: string,
  params: TransferRelayParams,
): Promise<RelayResult> {
  const res = await fetch(`${url}/relay/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`relayTransfer failed ${res.status}: ${(body as { error: string }).error}`);
  }
  return res.json() as Promise<RelayResult>;
}

/**
 * Poll /status/:txHash until terminal or timeout.
 * Returns the last known status.
 */
export async function waitForStatus(
  url: string,
  txHash: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<TxOutcome> {
  const pollMs = opts.pollMs ?? 2_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);

  while (Date.now() < deadline) {
    const res = await fetch(`${url}/status/${txHash}`).catch(() => null);
    if (res?.ok) {
      const body = await res.json() as { status: TxOutcome };
      if (body.status === "confirmed" || body.status === "failed") return body.status;
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return "unknown";
}

// ── selfRelay fallback ─────────────────────────────────────────────────────

export interface SelfRelayWallet {
  sendTransaction(tx: {
    to: `0x${string}`;
    data: `0x${string}`;
    gas: bigint;
  }): Promise<`0x${string}`>;
}

/**
 * selfRelay: submit tx directly from the user's wallet.
 * WARNING: this links the user's EOA address to the shielded note.
 *
 * @param wallet  - wallet that can sendTransaction
 * @param to      - pool contract address
 * @param data    - encoded calldata
 * @param gas     - explicit gas limit
 */
export async function selfRelay(
  wallet: SelfRelayWallet,
  to: `0x${string}`,
  data: `0x${string}`,
  gas: bigint,
): Promise<`0x${string}`> {
  console.warn(
    "[Pii] WARNING: selfRelay links your EOA address to this shielded operation. " +
    "Use a relayer for full privacy.",
  );
  return wallet.sendTransaction({ to, data, gas });
}
