/**
 * relayer/src/config.ts
 * Loads and validates all configuration from environment variables.
 * The server refuses to start if any required var is missing.
 */

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

// ── Required env vars ──────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// ── Chain definition (Arc Testnet or Anvil) ────────────────────────────────

const chainId = parseInt(process.env.CHAIN_ID ?? "31337", 10);
const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";

export const chain = defineChain({
  id: chainId,
  name: "Pii Local",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});

// ── Secrets ────────────────────────────────────────────────────────────────

const rawPrivKey = requireEnv("RELAYER_PRIVATE_KEY") as Hex;
const rawSpendingKey = requireEnv("RELAYER_SPENDING_KEY");

export const account = privateKeyToAccount(rawPrivKey);

/** Poseidon-derived spending key (bigint) for receiving fee notes */
export const relayerSpendingKey = BigInt(rawSpendingKey);

// ── Pool config ────────────────────────────────────────────────────────────

export const POOL_ADDRESS = requireEnv("POOL_ADDRESS") as Hex;
export const MIN_FEE = BigInt(process.env.MIN_FEE ?? "1000");
export const PORT = parseInt(process.env.PORT ?? "3001", 10);
export const RATE_LIMIT_RPM = parseInt(process.env.RATE_LIMIT_RPM ?? "10", 10);

// ── Viem clients ───────────────────────────────────────────────────────────

export const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

export const walletClient = createWalletClient({
  account,
  chain,
  transport: http(rpcUrl),
});
