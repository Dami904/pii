#!/usr/bin/env bun
/**
 * scripts/deploy-arc-mainnet.ts
 *
 * Deploys all Pii contracts to Arc Mainnet (chain ID 5042).
 * NO BROADCAST unless --confirm-mainnet is passed.
 *
 * Prerequisites:
 *   - MAINNET_DEPLOYER_KEY  (private key; must differ from MAINNET_OWNER)
 *   - MAINNET_OWNER         (address that will own PiiPool; required)
 *   - Contracts compiled: forge build
 *
 * Usage:
 *   bun run scripts/deploy-arc-mainnet.ts --confirm-mainnet
 *
 * Writes: deployments/arc-mainnet.json
 *
 * After deploy, verifies each contract on Sourcify:
 *   forge verify-contract <addr> <name> \
 *     --chain 5042 --verifier sourcify [--libraries ...] [--constructor-args ...]
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
import { execSync } from "node:child_process";

// ── Arc Mainnet chain definition (viem doesn't include arc mainnet built-in) ──

const arcMainnet = {
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.arc.io"] },
  },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
} as const;

const EXPLORER = "https://explorer.arc.io";
function explorerTx(hash: string): string { return `${EXPLORER}/tx/${hash}`; }

// ── Config ───────────────────────────────────────────────────────────────────

const ROOT = join((import.meta as unknown as { dir: string }).dir, "..");

// Arc Mainnet USDC — same address as testnet (ERC-20 view)
const USDC_ADDR = "0x3600000000000000000000000000000000000000" as Hex;

// PiiPool caps (in USDC base units, 6 decimals) — small caps for mainnet beta
const MAX_DEPOSIT      = 5_000_000n;   // 5 USDC
const MAX_POOL_BALANCE = 50_000_000n;  // 50 USDC

// ── Artifact helpers (shared with testnet script) ────────────────────────────

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
  if (!existsSync(path)) throw new Error(`Artifact not found: ${path} — run \`forge build\` first`);
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // ── Guards ────────────────────────────────────────────────────────────────

  if (!process.argv.includes("--confirm-mainnet")) {
    console.error(
      "\n[REFUSED] This script deploys to ARC MAINNET and involves REAL funds.\n" +
      "Pass --confirm-mainnet to proceed.\n" +
      "Example: bun run scripts/deploy-arc-mainnet.ts --confirm-mainnet"
    );
    process.exit(1);
  }

  const deployerKey = process.env.MAINNET_DEPLOYER_KEY as Hex | undefined;
  if (!deployerKey) throw new Error("MAINNET_DEPLOYER_KEY not set in .env");

  const ownerAddr = process.env.MAINNET_OWNER as Hex | undefined;
  if (!ownerAddr) throw new Error("MAINNET_OWNER not set in .env");

  const deployerAcc = privateKeyToAccount(deployerKey);
  if (ownerAddr.toLowerCase() === deployerAcc.address.toLowerCase()) {
    throw new Error(
      "MAINNET_OWNER must differ from the deployer address. " +
      "Using the deployer as owner concentrates risk — use a separate multisig or cold wallet."
    );
  }

  // Cap guard (same as testnet, same limits)
  const iKnowCaps = process.argv.includes("--i-know-caps");
  if (!iKnowCaps) {
    if (MAX_DEPOSIT > 10_000_000n)
      throw new Error(`MAX_DEPOSIT ${MAX_DEPOSIT} exceeds 10 USDC — pass --i-know-caps to override`);
    if (MAX_POOL_BALANCE > 100_000_000n)
      throw new Error(`MAX_POOL_BALANCE ${MAX_POOL_BALANCE} exceeds 100 USDC — pass --i-know-caps to override`);
  }

  console.log("\n=== Pii Arc Mainnet Deploy ===");
  console.log(`Deployer: ${deployerAcc.address}`);
  console.log(`Owner:    ${ownerAddr}`);
  console.log(`MaxDeposit: ${Number(MAX_DEPOSIT) / 1e6} USDC`);
  console.log(`MaxPoolBalance: ${Number(MAX_POOL_BALANCE) / 1e6} USDC`);

  const pub = createPublicClient({ chain: arcMainnet, transport: http() });
  const wal = createWalletClient({ account: deployerAcc, chain: arcMainnet, transport: http() });

  // Check deployer balance
  const bal = await pub.readContract({
    address: USDC_ADDR,
    abi: [{ name: "balanceOf", type: "function", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }],
    functionName: "balanceOf",
    args: [deployerAcc.address],
  });
  console.log(`Deployer USDC balance: ${Number(bal) / 1e6} USDC`);
  // 6 deploys × estimated gas; require ≥ 5 USDC to be safe
  if (bal < 5_000_000n) {
    throw new Error(
      `Insufficient balance. Deployer ${deployerAcc.address} needs ≥ 5 USDC on Arc Mainnet.\n` +
      `Current balance: ${Number(bal) / 1e6} USDC.`
    );
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
    const hash = await wal.deployContract({ abi: abi as [], bytecode, args, gas });
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

  // 5. PiiPool — owner is MAINNET_OWNER, not the deployer
  const POOL_ADDR = await deploy(
    "PiiPool",
    bc(poolArt),
    15_000_000n,
    [USDC_ADDR, WV_ADDR, TV_ADDR, ownerAddr, MAX_DEPOSIT, MAX_POOL_BALANCE],
    poolArt.abi,
  );

  // 6. PiiKeyRegistry
  const REGISTRY_ADDR = await deploy("PiiKeyRegistry", bc(registryArt), 3_000_000n, [], registryArt.abi);

  // ── Post-deploy assertions ────────────────────────────────────────────────

  console.log("\n[Asserting on-chain state...]");

  const POOL_ABI = [
    { name: "maxDeposit",      type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "maxPoolBalance",  type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "owner",           type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  ] as const;

  const [onchainMaxDeposit, onchainMaxPoolBalance, onchainOwner] = await Promise.all([
    pub.readContract({ address: POOL_ADDR, abi: POOL_ABI, functionName: "maxDeposit" }),
    pub.readContract({ address: POOL_ADDR, abi: POOL_ABI, functionName: "maxPoolBalance" }),
    pub.readContract({ address: POOL_ADDR, abi: POOL_ABI, functionName: "owner" }),
  ]);

  if (onchainMaxDeposit !== MAX_DEPOSIT)
    throw new Error(`maxDeposit mismatch: expected ${MAX_DEPOSIT}, got ${onchainMaxDeposit}`);
  if (onchainMaxPoolBalance !== MAX_POOL_BALANCE)
    throw new Error(`maxPoolBalance mismatch: expected ${MAX_POOL_BALANCE}, got ${onchainMaxPoolBalance}`);
  if ((onchainOwner as string).toLowerCase() !== ownerAddr.toLowerCase())
    throw new Error(`owner mismatch: expected ${ownerAddr}, got ${onchainOwner}`);

  console.log("  maxDeposit:     OK");
  console.log("  maxPoolBalance: OK");
  console.log("  owner:          OK");

  // ── Write deployment record ───────────────────────────────────────────────

  const deploymentRecord = {
    chainId:     5042,
    network:     "arc-mainnet",
    deployBlock,
    deployer:    deployerAcc.address,
    owner:       ownerAddr,
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
  const outPath = join(outDir, "arc-mainnet.json");
  writeFileSync(outPath, JSON.stringify(deploymentRecord, null, 2));
  console.log(`\nDeployment record written to deployments/arc-mainnet.json`);

  // ── Sourcify verification ─────────────────────────────────────────────────

  console.log("\n[Sourcify verification...]");

  const libArgs =
    `--libraries contracts/verifiers/WithdrawVerifier.sol:ZKTranscriptLib:${ZK_TRANS_ADDR}` +
    ` --libraries contracts/verifiers/WithdrawVerifier.sol:RelationsLib:${RELATIONS_ADDR}` +
    ` --libraries contracts/verifiers/TransferVerifier.sol:ZKTranscriptLib:${ZK_TRANS_ADDR}` +
    ` --libraries contracts/verifiers/TransferVerifier.sol:RelationsLib:${RELATIONS_ADDR}`;

  const poolCtorArgs = [USDC_ADDR, WV_ADDR, TV_ADDR, ownerAddr, MAX_DEPOSIT, MAX_POOL_BALANCE];

  const verifications: Array<{ name: string; addr: Hex; extra?: string }> = [
    { name: "ZKTranscriptLib", addr: ZK_TRANS_ADDR },
    { name: "RelationsLib",    addr: RELATIONS_ADDR },
    { name: "WithdrawVerifier", addr: WV_ADDR, extra: libArgs },
    { name: "TransferVerifier", addr: TV_ADDR, extra: libArgs },
    {
      name: "PiiPool",
      addr: POOL_ADDR,
      extra: `--constructor-args $(cast abi-encode "constructor(address,address,address,address,uint256,uint256)" ${poolCtorArgs.join(" ")})`,
    },
    { name: "PiiKeyRegistry", addr: REGISTRY_ADDR },
  ];

  for (const v of verifications) {
    console.log(`  Verifying ${v.name} at ${v.addr}...`);
    try {
      const cmd =
        `forge verify-contract ${v.addr} ${v.name} --chain 5042 --verifier sourcify ${v.extra ?? ""}`;
      execSync(cmd, { cwd: ROOT, stdio: "inherit" });
      console.log(`  ${v.name}: verified`);
    } catch {
      console.warn(`  ${v.name}: verification failed (may retry manually)`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log("\n=== Arc Mainnet deployment complete ===");
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
  }
}

main().catch(e => {
  console.error("\n[DEPLOY FAILED]", e);
  process.exit(1);
});
