/**
 * api/rpc.ts
 * Same-origin, read-only JSON-RPC proxy to the Arc RPC.
 *
 * Why: browser extensions (ad/privacy blockers) and some networks block direct
 * requests to rpc.*.arc.io. Requests to our own domain are not blocked.
 *
 * Only read methods are forwarded. Transactions are signed and broadcast by the
 * user's wallet through its own RPC, never through this endpoint.
 * Privacy: request bodies are never logged.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const config = { maxDuration: 30 };

const ALLOWED = new Set([
  "eth_call",
  "eth_chainId",
  "eth_blockNumber",
  "eth_getLogs",
  "eth_getBalance",
  "eth_getCode",
  "eth_getBlockByNumber",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "net_version",
]);

const MAX_BATCH = 20;
const MAX_BODY_BYTES = 100_000;

function allowed(call: unknown): boolean {
  return (
    typeof call === "object" &&
    call !== null &&
    typeof (call as { method?: unknown }).method === "string" &&
    ALLOWED.has((call as { method: string }).method)
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const upstream = process.env.RPC_URL;
  if (!upstream) {
    res.status(500).json({ error: "rpc not configured" });
    return;
  }

  const body: unknown = req.body;
  const calls = Array.isArray(body) ? body : [body];
  if (
    calls.length === 0 ||
    calls.length > MAX_BATCH ||
    !calls.every(allowed) ||
    JSON.stringify(body).length > MAX_BODY_BYTES
  ) {
    res.status(400).json({ error: "method not allowed" });
    return;
  }

  // The upstream limits requests per source address, and ours is shared: retry briefly.
  const payload = JSON.stringify(body);
  try {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
      const text = await r.text();
      const limited = r.status === 429 || /rate limit/i.test(text);
      if (limited && attempt < 3) {
        await new Promise((ok) => setTimeout(ok, 400 * 2 ** attempt));
        continue;
      }
      res.status(r.status);
      res.setHeader("content-type", "application/json");
      res.send(text);
      return;
    }
  } catch {
    res.status(502).json({ error: "upstream unavailable" });
  }
}
