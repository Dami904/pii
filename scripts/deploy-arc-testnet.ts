#!/usr/bin/env bun
/**
 * scripts/deploy-arc-testnet.ts
 *
 * Deploys all Pii contracts to Arc Testnet in the correct order:
 *   1. ZKTranscriptLib  (external library)
 *   2. RelationsLib     (external library)
 *   3. WithdrawVerifier (linked against the above)
 *   4. TransferVerifier (linked against the above)
 *   5. PiiPool          (takes verifier addresses in constructor)
 *   6. PiiKeyRegistry
 *
 * Prerequisites:
 *   - TESTNET_DEPLOYER_KEY set in .env (private key with Arc Testnet USDC for gas)
 *   - Contracts compiled: forge build (run from /home/user/app)
 *
 * Usage:
 *   bun run scripts/deploy-arc-testnet.ts
 *
 * Writes: deployments/arc-testnet.json
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { arcTestnet } from "viem/chains";

// ── Arc Testnet explorer ────────────────────────────────────────────────────

const EXPLORER = "https://explorer.testnet.arc.io";

function explorerTx(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

// ── Config ──────────────────────────────────────────────────────────────────

const ROOT = join((import.meta as unknown as { dir: string }).dir, "..");

// Arc Testnet USDC (native gas token)
const USDC_ADDR = "0x3600000000000000000000000000000000000000" as Hex;

// PiiPool caps (in USDC base units, 6 decimals)
// 5 USDC = 5_000_000 atoms (6 decimals).  Do NOT multiply by 10^6 again.
const MAX_DEPOSIT       = 5_000_000n;   // 5 USDC
const MAX_POOL_BALANCE  = 50_000_000n;  // 50 USDC

// ── Artifact helpers ────────────────────────────────────────────────────────

type Artifact = {
  abi: unknown[];
  bytecode: {
    object: string;
    linkReferences?: Record<string, Record<string, Array<{ start: number; length: number }>>>;
  };
};

function readArtifact(name: string, solFile?: string): Artifact {
  const sol  = solFile ?? name;
  const path = join(ROOT, `contracts/out/${sol}.sol/${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`Artifact not found: ${path} — run \`forge build\` first`);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as Artifact;
}

function bc(art: Artifact): Hex {
  const b = art.bytecode.object;
  return (b.startsWith("0x") ? b : `0x${b}`) as Hex;
}

function linkBytecode(
  bytecodeHex: string,
  linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>,
  libs: Record<string, string>,
): Hex {
  let hex = bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex;
  for (const [file, fileRefs] of Object.entries(linkReferences)) {
    for (const [libName, slots] of Object.entries(fileRefs)) {
      const key  = `${file}:${libName}`;
      const addr = libs[key];
      if (!addr) throw new Error(`Missing library address for ${key}`);
      const addrHex = addr.replace(/^0x/i, "").toLowerCase().padStart(40, "0");
      for (const { start, length } of slots) {
        if (length !== 20) throw new Error(`Unexpected link slot length ${length} for ${key}`);
        const byteStart = start * 2;
        hex = hex.slice(0, byteStart) + addrHex + hex.slice(byteStart + length * 2);
      }
    }
  }
  return `0x${hex}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const deployerKey = process.env.TESTNET_DEPLOYER_KEY as Hex | undefined;
  if (!deployerKey) {
    throw new Error("TESTNET_DEPLOYER_KEY not set in .env");
  }

  const deployerAcc = privateKeyToAccount(deployerKey);
  console.log(`\nDeployer: ${deployerAcc.address}`);

  const pub = createPublicClient({ chain: arcTestnet, transport: http() });
  const wal = createWalletClient({ account: deployerAcc, chain: arcTestnet, transport: http() });

  // Check deployer balance
  const bal = await pub.readContract({
    address: USDC_ADDR,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [deployerAcc.address],
  });
  console.log(`Deployer USDC balance: ${Number(bal) / 1e6} USDC`);
  // 6 deploys × 5M gas × 25 gwei × 1.5 safety = ~2.8 USDC; require ≥ 2 USDC
  if (bal < 2_000_000n) {
    throw new Error(
      `Insufficient balance. Deployer ${deployerAcc.address} needs at least 2 USDC on Arc Testnet.\n` +
      `Current balance: ${Number(bal) / 1e6} USDC.\n` +
      `Fund via https://faucet.circle.com (select Arc Testnet, USDC).`
    );
  }

  // Guard against accidental large caps (pass --i-know-caps to override)
  const iKnowCaps = process.argv.includes("--i-know-caps");
  const TEN_USDC  = 10_000_000n;   // 10 USDC in atoms
  const HUNDRED_USDC = 100_000_000n; // 100 USDC in atoms
  if (!iKnowCaps) {
    if (MAX_DEPOSIT > TEN_USDC)
      throw new Error(`MAX_DEPOSIT ${MAX_DEPOSIT} exceeds 10 USDC. Pass --i-know-caps to override.`);
    if (MAX_POOL_BALANCE > HUNDRED_USDC)
      throw new Error(`MAX_POOL_BALANCE ${MAX_POOL_BALANCE} exceeds 100 USDC. Pass --i-know-caps to override.`);
  }

  // Load artifacts
  const zkTransArt   = readArtifact("ZKTranscriptLib", "WithdrawVerifier");
  const relationsArt = readArtifact("RelationsLib",    "WithdrawVerifier");
  const wvArt        = readArtifact("WithdrawVerifier");
  const tvArt        = readArtifact("TransferVerifier");
  const poolArt      = readArtifact("PiiPool");
  const registryArt  = readArtifact("PiiKeyRegistry");

  type DeployedContract = { name: string; address: Hex; txHash: Hex; blockNumber: number };
  const deployed: DeployedContract[] = [];
  let deployBlock = 0;

  async function deploy(
    name: string,
    bytecode: Hex,
    gas: bigint,
    args: readonly unknown[] = [],
    abi: unknown[] = [],
  ): Promise<Hex> {
    console.log(`\nDeploying ${name}...`);
    const hash = await wal.deployContract({
      abi: abi as [],
      bytecode,
      args: args,
      gas,
    });
    console.log(`  tx: ${explorerTx(hash)}`);
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== "success") throw new Error(`${name} deploy failed: ${hash}`);
    const addr = receipt.contractAddress!;
    const blockNum = Number(receipt.blockNumber);
    if (deployBlock === 0) deployBlock = blockNum;
    deployed.push({ name, address: addr, txHash: hash, blockNumber: blockNum });
    console.log(`  address: ${addr}  block: ${blockNum}  gas: ${receipt.gasUsed}`);
    return addr;
  }

  // 1. ZKTranscriptLib
  const ZK_TRANS_ADDR = await deploy("ZKTranscriptLib", bc(zkTransArt), 3_000_000n);

  // 2. RelationsLib
  const RELATIONS_ADDR = await deploy("RelationsLib", bc(relationsArt), 5_000_000n);

  const libMap: Record<string, string> = {
    "contracts/verifiers/WithdrawVerifier.sol:ZKTranscriptLib": ZK_TRANS_ADDR,
    "contracts/verifiers/WithdrawVerifier.sol:RelationsLib":    RELATIONS_ADDR,
    "contracts/verifiers/TransferVerifier.sol:ZKTranscriptLib": ZK_TRANS_ADDR,
    "contracts/verifiers/TransferVerifier.sol:RelationsLib":    RELATIONS_ADDR,
  };

  // 3. WithdrawVerifier (linked)
  const wvLinked = linkBytecode(wvArt.bytecode.object, wvArt.bytecode.linkReferences ?? {}, libMap);
  const WV_ADDR  = await deploy("WithdrawVerifier", wvLinked, 10_000_000n, [], wvArt.abi);

  // 4. TransferVerifier (linked)
  const tvLinked = linkBytecode(tvArt.bytecode.object, tvArt.bytecode.linkReferences ?? {}, libMap);
  const TV_ADDR  = await deploy("TransferVerifier", tvLinked, 10_000_000n, [], tvArt.abi);

  // 5. PiiPool
  const POOL_ADDR = await deploy(
    "PiiPool",
    bc(poolArt),
    15_000_000n,
    [USDC_ADDR, WV_ADDR, TV_ADDR, deployerAcc.address, MAX_DEPOSIT, MAX_POOL_BALANCE],
    poolArt.abi,
  );

  // 6. PiiKeyRegistry
  const REGISTRY_ADDR = await deploy("PiiKeyRegistry", bc(registryArt), 3_000_000n, [], registryArt.abi);

  // ── Write deployment record ───────────────────────────────────────────────

  const deploymentRecord = {
    chainId:     5042002,
    network:     "arc-testnet",
    deployBlock,
    deployer:    deployerAcc.address,
    contracts: {
      ZKTranscriptLib:  deployed.find(d => d.name === "ZKTranscriptLib")!,
      RelationsLib:     deployed.find(d => d.name === "RelationsLib")!,
      WithdrawVerifier: deployed.find(d => d.name === "WithdrawVerifier")!,
      TransferVerifier: deployed.find(d => d.name === "TransferVerifier")!,
      PiiPool:          deployed.find(d => d.name === "PiiPool")!,
      PiiKeyRegistry:   deployed.find(d => d.name === "PiiKeyRegistry")!,
    },
    usdc:    USDC_ADDR,
    explorer: EXPLORER,
  };

  const outDir = join(ROOT, "deployments");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "arc-testnet.json");
  writeFileSync(outPath, JSON.stringify(deploymentRecord, null, 2));
  console.log(`\nDeployment record written to deployments/arc-testnet.json`);

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n=== Arc Testnet deployment complete ===");
  console.log(`Deploy block:      ${deployBlock}`);
  console.log(`PiiPool:           ${POOL_ADDR}`);
  console.log(`PiiKeyRegistry:    ${REGISTRY_ADDR}`);
  console.log(`WithdrawVerifier:  ${WV_ADDR}`);
  console.log(`TransferVerifier:  ${TV_ADDR}`);
  console.log(`ZKTranscriptLib:   ${ZK_TRANS_ADDR}`);
  console.log(`RelationsLib:      ${RELATIONS_ADDR}`);
  console.log("\nExplorer links:");
  for (const c of deployed) {
    console.log(`  ${c.name}: ${EXPLORER}/address/${c.address}`);
    console.log(`    deploy tx: ${explorerTx(c.txHash)}`);
  }
}

main().catch(e => {
  console.error("\n[DEPLOY FAILED]", e);
  process.exit(1);
});
