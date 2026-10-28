/**
 * sdk/src/config.ts
 *
 * Network-specific defaults for the Pii SDK.
 * Import these constants rather than hardcoding addresses in scripts.
 */

export const ARC_TESTNET = {
  chainId: 5042002,
  rpcUrl: "https://rpc.testnet.arc.io",
  explorer: "https://explorer.testnet.arc.io",
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  pool: "0x75bc90aa025caeedde588295d42b8f19a8e4bff3" as `0x${string}`,
  keyRegistry: "0x9e3a4256791edcba981d88e55d932a76b9cb8e29" as `0x${string}`,
  withdrawVerifier: "0xa412b824f53650a9b582bf685b7bfe31bf324721" as `0x${string}`,
  transferVerifier: "0x1b55cbe0de87cef666160762d42da1f3358de39e" as `0x${string}`,
  deployBlock: 69004920,
  relayerUrl: "http://localhost:3001",
} as const;

export const LOCAL_ANVIL = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  explorer: "",
  usdc: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  // Addresses populated at runtime by the anvil-e2e deploy step
  pool: "" as `0x${string}`,
  keyRegistry: "" as `0x${string}`,
  deployBlock: 0,
  relayerUrl: "http://localhost:3002",
} as const;
