/**
 * api/relay/[...path].ts
 * Vercel serverless function — adapts incoming Vercel requests to the
 * platform-neutral relayer handler.
 *
 * Routes:
 *   GET  /api/relay/info
 *   GET  /api/relay/status/:txHash
 *   POST /api/relay/relay/withdraw
 *   POST /api/relay/relay/transfer
 *
 * Privacy: never logs request bodies, IPs, or user agents.
 * Config is read from Vercel encrypted env vars at cold-start.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { handleRequest } from "../../relayer/src/handler.js";

export const config = { maxDuration: 120 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Reconstruct a Web API Request from the Vercel IncomingMessage
  const proto = req.headers["x-forwarded-proto"] ?? "https";
  const host  = req.headers.host ?? "localhost";
  const url   = new URL(`${proto}://${host}${req.url ?? "/"}`);

  const init: RequestInit = { method: req.method ?? "GET" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", resolve);
      req.on("error", reject);
    });
    init.body = Buffer.concat(chunks);
  }

  // Copy headers (excluding host to avoid conflicts)
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === "host") continue;
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else if (v) headers.set(k, v);
  }
  init.headers = headers;

  const webReq = new Request(url.toString(), init);
  const webRes = await handleRequest(webReq, url);

  res.status(webRes.status);
  webRes.headers.forEach((v, k) => res.setHeader(k, v));
  const body = await webRes.text();
  res.send(body);
}
