/**
 * relayer/src/rateLimit.ts
 * In-memory per-IP rate limiting. Never persisted.
 */

import { RATE_LIMIT_RPM } from "./config.js";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(ip: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const windowMs = 60_000;
  let b = buckets.get(ip);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(ip, b);
  }
  b.count++;
  if (b.count > RATE_LIMIT_RPM) {
    return { ok: false, retryAfterMs: b.resetAt - now };
  }
  return { ok: true, retryAfterMs: 0 };
}

// Prune stale buckets every 5 minutes to prevent unbounded growth.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now >= v.resetAt) buckets.delete(k);
  }
}, 300_000).unref();
