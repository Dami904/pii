#!/usr/bin/env bun
/**
 * scripts/set-caps-testnet.ts
 *
 * Calls PiiPool.setCaps(maxDeposit, maxPoolBalance) on Arc Testnet
 * to correct the original over-inflated caps.
 *
 * Usage: bun run scripts/set-caps-testnet.ts
 */

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";

const DEPLOYER_KEY = (process.env.TESTNET_DEPLOYER_KEY ?? "") as Hex;
if (!DEPLOYER_KEY) throw new Error("TESTNET_DEPLOYER_KEY not set in .env");

const POOL_ADDR   = "0x75bc90aa025caeedde588295d42b8f19a8e4bff3" as Hex;
const EXPLORER    = "https://explorer.testnet.arc.io";

// Correct testnet caps: 5 USDC max deposit, 50 USDC max pool balance
const MAX_DEPOSIT      = 5_000_000n;  // 5 USDC (6 decimals)
const MAX_POOL_BALANCE = 50_000_000n; // 50 USDC

const SET_CAPS_ABI = [{
  name: "setCaps",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "maxDeposit_", type: "uint256" },
    { name: "maxPoolBalance_", type: "uint256" },
  ],
  outputs: [],
}] as const;

const deployerAcc = privateKeyToAccount(DEPLOYER_KEY);
const pub = createPublicClient({ chain: arcTestnet, transport: http() });
const wal = createWalletClient({ account: deployerAcc, chain: arcTestnet, transport: http() });

console.log(`Setting PiiPool caps on Arc Testnet...`);
console.log(`  pool:           ${POOL_ADDR}`);
console.log(`  maxDeposit:     ${MAX_DEPOSIT} atoms = ${Number(MAX_DEPOSIT) / 1e6} USDC`);
console.log(`  maxPoolBalance: ${MAX_POOL_BALANCE} atoms = ${Number(MAX_POOL_BALANCE) / 1e6} USDC`);

const hash = await wal.writeContract({
  address: POOL_ADDR,
  abi: SET_CAPS_ABI,
  functionName: "setCaps",
  args: [MAX_DEPOSIT, MAX_POOL_BALANCE],
  gas: 100_000n,
});

console.log(`  tx: ${EXPLORER}/tx/${hash}`);
const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
if (receipt.status !== "success") throw new Error(`setCaps failed: ${hash}`);
console.log(`  confirmed in block ${receipt.blockNumber}  gas: ${receipt.gasUsed}`);
console.log(`\nSetCaps tx: ${EXPLORER}/tx/${hash}`);
