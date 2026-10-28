/**
 * relayer/src/handler.ts
 * Platform-neutral request handler shared by Bun.serve (index.ts) and
 * the Vercel serverless adapter (api/relay/[...path].ts).
 *
 * Privacy: never log request bodies, IPs, or user agents.
 */

import { account, POOL_ADDRESS, MIN_FEE, chain, publicClient, walletClient } from "./config.js";
import { validateWithdraw, validateTransfer, RELAYER_OWNER_KEY, type WithdrawRequest, type TransferRequest } from "./validate.js";
import { pool, POOL_ABI } from "./pool.js";
import { checkRateLimit } from "./rateLimit.js";
import { submitAndTrack } from "../../sdk/src/tx.js";

const WITHDRAW_GAS = 5_000_000n;
const TRANSFER_GAS = 7_000_000n;

// ── In-memory tx status (resets on cold start) ─────────────────────────────

export const txStore = new Map<string, "confirmed" | "failed" | "unknown">();

// ── Helpers ────────────────────────────────────────────────────────────────

export function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ipFrom(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// ── Main handler ───────────────────────────────────────────────────────────

export async function handleRequest(req: Request, urlOverride?: URL): Promise<Response> {
  const url = urlOverride ?? new URL(req.url);
  // Strip the Vercel prefix /api/relay so paths match the Bun handler
  let path = url.pathname.replace(/^\/api\/relay/, "");
  if (!path.startsWith("/")) path = "/" + path;
  const method = req.method;

  // Rate-limit on POST endpoints only
  if (method === "POST") {
    const ip = ipFrom(req);
    const rl = checkRateLimit(ip);
    if (!rl.ok) return jsonResp({ error: "rate limit exceeded" }, 429);
  }

  // GET /info
  if (method === "GET" && path === "/info") {
    return jsonResp({
      relayerAddress: account.address,
      relayerOwnerKey: "0x" + RELAYER_OWNER_KEY.toString(16).padStart(64, "0"),
      minFee: MIN_FEE.toString(),
      chainId: chain.id,
      pool: POOL_ADDRESS,
    });
  }

  // GET /status/:txHash
  if (method === "GET" && path.startsWith("/status/")) {
    const txHash = path.slice("/status/".length);
    const status = txStore.get(txHash) ?? "unknown";
    return jsonResp({ txHash, status });
  }

  // POST /relay/withdraw
  if (method === "POST" && path === "/relay/withdraw") {
    let body: WithdrawRequest;
    try {
      body = await req.json() as WithdrawRequest;
    } catch {
      return jsonResp({ error: "invalid JSON" }, 400);
    }

    const err = await validateWithdraw(body);
    if (err) return jsonResp({ error: err.message }, err.status);

    const nf = BigInt(body.nullifier);
    const sendFn = async () => {
      const { request } = await publicClient.simulateContract({
        address: POOL_ADDRESS,
        abi: POOL_ABI,
        functionName: "withdraw",
        args: [
          body.proof,
          BigInt(body.root),
          nf,
          body.recipient,
          BigInt(body.amount),
          BigInt(body.changeCommitment),
          body.relayer,
          BigInt(body.fee),
          body.memos,
        ],
        account: account.address,
      });
      const gasLimit = request.gas
        ? ((request.gas * 120n) / 100n < WITHDRAW_GAS ? (request.gas * 120n) / 100n : WITHDRAW_GAS)
        : WITHDRAW_GAS;
      return walletClient.writeContract({ ...request, account, gas: gasLimit });
    };

    const mockPool = {
      read: { nullifierSpent: ([n]: [bigint]) => pool.read.nullifierSpent([n]) },
    };

    let txHash = "";
    const trackSend = async () => { const h = await sendFn(); txHash = h; return h; };
    const outcome = await submitAndTrack(trackSend, [nf], mockPool, publicClient, 60_000);

    if (txHash) {
      txStore.set(txHash, outcome);
      console.log(`[withdraw] tx=${txHash} status=${outcome}`);
    }
    if (outcome === "failed") {
      console.error(`[withdraw] REVERTED tx=${txHash}`);
      return jsonResp({ error: "transaction reverted" }, 500);
    }
    return jsonResp({ txHash, status: outcome });
  }

  // POST /relay/transfer
  if (method === "POST" && path === "/relay/transfer") {
    let body: TransferRequest;
    try {
      body = await req.json() as TransferRequest;
    } catch {
      return jsonResp({ error: "invalid JSON" }, 400);
    }

    const err = await validateTransfer(body);
    if (err) return jsonResp({ error: err.message }, err.status);

    const nf0 = BigInt(body.args.nf0);
    const nf1 = BigInt(body.args.nf1);
    const nfFee = BigInt(body.args.nfFee);

    const sendFn = async () => {
      const { request } = await publicClient.simulateContract({
        address: POOL_ADDRESS,
        abi: POOL_ABI,
        functionName: "transfer",
        args: [
          body.proof,
          {
            root: BigInt(body.args.root),
            nf0,
            nf1,
            nfFee,
            outRecipient: BigInt(body.args.outRecipient),
            outChange: BigInt(body.args.outChange),
            outFee: BigInt(body.args.outFee),
            outFeeChange: BigInt(body.args.outFeeChange),
            eligibilityRoot: BigInt(body.args.eligibilityRoot),
            fee: BigInt(body.args.fee),
            relayerOwnerKey: BigInt(body.args.relayerOwnerKey),
          },
          body.relayer,
          body.memos,
        ],
        account: account.address,
      });
      const gasLimit = request.gas
        ? ((request.gas * 120n) / 100n < TRANSFER_GAS ? (request.gas * 120n) / 100n : TRANSFER_GAS)
        : TRANSFER_GAS;
      return walletClient.writeContract({ ...request, account, gas: gasLimit });
    };

    const nullifiers = [nf0, nf1, nfFee].filter(n => n !== 0n);
    const mockPool = {
      read: { nullifierSpent: ([n]: [bigint]) => pool.read.nullifierSpent([n]) },
    };

    let txHash = "";
    const trackSend = async () => { const h = await sendFn(); txHash = h; return h; };
    const outcome = await submitAndTrack(trackSend, nullifiers, mockPool, publicClient, 60_000);

    if (txHash) {
      txStore.set(txHash, outcome);
      console.log(`[transfer] tx=${txHash} status=${outcome}`);
    }
    if (outcome === "failed") {
      console.error(`[transfer] REVERTED tx=${txHash}`);
      return jsonResp({ error: "transaction reverted" }, 500);
    }
    return jsonResp({ txHash, status: outcome });
  }

  return jsonResp({ error: "not found" }, 404);
}
