#!/usr/bin/env bun
/**
 * scripts/anvil-e2e.ts
 *
 * Full end-to-end test on a local anvil instance (chainId 31337).
 *
 * Flow:
 *   1.  Start anvil on port 8545.
 *   2.  Deploy mock ERC-20 at 0x3600000000000000000000000000000000000000 via anvil_setCode.
 *   3.  Deploy WithdrawVerifier, TransferVerifier, PiiPool.
 *   4.  Start the relayer.
 *   5.  User A: derive keys, deposit 3 notes with SDK memos.
 *   6.  User A: prove transfer to B (fee to relayer) via relayer.
 *   7.  User B: recoverWallet from events, prove withdraw via relayer.
 *   8.  Relayer: recoverWallet — finds its fee note.
 *   9.  Assert balances and that A's EOA never appears as tx.from for steps 6+7.
 *   10. Negative: relayer rejects short memo, wrong relayerOwnerKey, low fee, replay.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  defineChain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildTree,
  syncTree,
  type SyncResult,
  type PublicClientLike,
} from "../sdk/src/tree.js";
import {
  nullifier as noteNullifier,
  randomBlinding,
} from "../sdk/src/note.js";
import type { Note } from "../sdk/src/note.js";
import { hash2 } from "../sdk/src/hash.js";
import { buildWithdrawInputs, buildTransferInputs } from "../sdk/src/inputs.js";
import { proveWithdraw, proveTransfer } from "../sdk/src/prover.js";
import { encryptMemo, dummyMemo, deriveViewingKeys } from "../sdk/src/memo.js";
import { recoverWallet } from "../sdk/src/wallet.js";
import { relayWithdraw, relayTransfer, getRelayerInfo } from "../sdk/src/relayer.js";
import type { TransferRelayParams, WithdrawRelayParams } from "../sdk/src/relayer.js";
import { EMPTY_TREE_ROOT } from "../sdk/src/tree.js";

// Suppress unused-import warnings for re-exported symbols kept for reference
void buildTree; void randomBlinding; void noteNullifier; void EMPTY_TREE_ROOT;

// ── Constants ──────────────────────────────────────────────────────────────

// import.meta.dir is a Bun extension; cast through unknown to satisfy tsc.
const ROOT = join((import.meta as unknown as { dir: string }).dir, "..");
const CHAIN_ID = 31337n;
const ANVIL_PORT = 8545;
const RELAYER_PORT = 3002;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const RELAYER_URL = `http://127.0.0.1:${RELAYER_PORT}`;

// Anvil well-known accounts
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const USER_A_KEY   = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const USER_B_KEY   = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const RELAYER_KEY  = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex;

// Test spending keys (arbitrary fixed values)
const SK_A       = 111222333444555n;
const SK_B       = 999888777666555n;
const SK_RELAYER = 123456789012345n;

const USDC_ADDR  = "0x3600000000000000000000000000000000000000" as Hex;

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForAnvil(retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("anvil did not start in time");
}

async function waitForRelayer(retries = 20): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${RELAYER_URL}/info`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  throw new Error("relayer did not start in time");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function seedFrom(n: bigint): Uint8Array {
  const s = new Uint8Array(32);
  const h = n.toString(16).padStart(64, "0");
  for (let i = 0; i < 32; i++) s[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return s;
}

function toHex64(n: bigint): `0x${string}` {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

// ── Forge build check ──────────────────────────────────────────────────────

function ensureBuilt(): void {
  const withdrawJson = join(ROOT, "contracts/out/WithdrawVerifier.sol/WithdrawVerifier.json");
  if (!existsSync(withdrawJson)) {
    console.log("Building contracts...");
    execSync("forge build", { cwd: join(ROOT, "contracts"), stdio: "inherit" });
  }
}

type Artifact = {
  abi: unknown[];
  bytecode: {
    object: string;
    linkReferences?: Record<string, Record<string, Array<{ start: number; length: number }>>>;
  };
};

function readArtifact(name: string, solFile?: string): Artifact {
  const sol = solFile ?? name;
  const path = join(ROOT, `contracts/out/${sol}.sol/${name}.json`);
  return JSON.parse(readFileSync(path, "utf-8")) as Artifact;
}

/**
 * Patch `__$...$__` library placeholder slots in a bytecode hex string.
 * `linkReferences` is the Foundry artifact linkReferences field.
 * `libs` maps "<solFile>:<LibraryName>" → deployed address.
 */
function linkBytecode(
  bytecodeHex: string,
  linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>,
  libs: Record<string, string>,
): `0x${string}` {
  let hex = bytecodeHex.startsWith("0x") ? bytecodeHex.slice(2) : bytecodeHex;
  for (const [file, fileRefs] of Object.entries(linkReferences)) {
    for (const [libName, slots] of Object.entries(fileRefs)) {
      const key = `${file}:${libName}`;
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

// ── viem PublicClient satisfies PublicClientLike ───────────────────────────
//
// viem's PublicClient has a more specific getLogs overload than our interface
// requires, but they are structurally compatible.  A single explicit cast at
// the call site (pub as PublicClientLike) is the only cast needed.

function asPCL(client: ReturnType<typeof createPublicClient>): PublicClientLike {
  return client as unknown as PublicClientLike;
}

// ── Main ───────────────────────────────────────────────────────────────────

let anvilProc: ChildProcess | null = null;
let relayerProc: ChildProcess | null = null;

async function main() {
  ensureBuilt();

  // Kill any stale anvil / relayer from a previous run.
  try { execSync("pkill -9 -f 'anvil --port' 2>/dev/null; true", { shell: "/bin/sh" }); } catch { /* ok */ }
  try { execSync("pkill -9 -f 'relayer/src/index' 2>/dev/null; true", { shell: "/bin/sh" }); } catch { /* ok */ }
  await sleep(600);

  // 1. Start anvil
  console.log("\n=== Pii anvil E2E ===\n");
  console.log("[1] Starting anvil...");
  anvilProc = spawn("anvil", ["--port", String(ANVIL_PORT), "--chain-id", "31337"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  await waitForAnvil();
  console.log("    anvil ready");

  const localChain = defineChain({
    id: 31337,
    name: "Anvil",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });

  const deployerAcc = privateKeyToAccount(DEPLOYER_KEY);
  const userAAcc    = privateKeyToAccount(USER_A_KEY);
  const userBAcc    = privateKeyToAccount(USER_B_KEY);
  const relayerAcc  = privateKeyToAccount(RELAYER_KEY);

  const pub  = createPublicClient({ chain: localChain, transport: http(RPC_URL) });
  const depW = createWalletClient({ account: deployerAcc, chain: localChain, transport: http(RPC_URL) });
  const userAW = createWalletClient({ account: userAAcc, chain: localChain, transport: http(RPC_URL) });

  // 2. Deploy mock ERC-20 at fixed USDC address via anvil_setCode
  console.log("\n[2] Deploying mock ERC-20 at USDC address...");

  const mockArt     = readArtifact("MockERC20");
  const mockBytecode = (mockArt.bytecode.object.startsWith("0x")
    ? mockArt.bytecode.object
    : `0x${mockArt.bytecode.object}`) as Hex;

  // Deploy to a temp address first to obtain the runtime bytecode.
  const mockDeployHash = await depW.deployContract({
    abi: mockArt.abi as [],
    bytecode: mockBytecode,
    args: [],
  });
  const mockReceipt = await pub.waitForTransactionReceipt({ hash: mockDeployHash });
  const mockTempAddr = mockReceipt.contractAddress!;

  const runtimeCode = await pub.getCode({ address: mockTempAddr });
  // anvil_setCode is not in viem's typed method list; cast through any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (pub as unknown as { request(r: unknown): Promise<unknown> }).request({
    method: "anvil_setCode",
    params: [USDC_ADDR, runtimeCode],
  });
  console.log(`    mock ERC-20 @ ${USDC_ADDR}`);

  const mockAbi = parseAbi([
    "function mint(address to, uint256 amount) external",
    "function balanceOf(address) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)",
  ]);

  // 3. Deploy verifiers + PiiPool
  console.log("\n[3] Deploying contracts...");
  const wvArt    = readArtifact("WithdrawVerifier");
  const tvArt    = readArtifact("TransferVerifier");
  const poolArt  = readArtifact("PiiPool");

  function bc(art: Artifact): Hex {
    const b = art.bytecode.object;
    return (b.startsWith("0x") ? b : `0x${b}`) as Hex;
  }

  // Both verifiers share ZKTranscriptLib and RelationsLib (defined in WithdrawVerifier.sol).
  const zkTransArt   = readArtifact("ZKTranscriptLib", "WithdrawVerifier");
  const relationsArt = readArtifact("RelationsLib",    "WithdrawVerifier");

  const zkTransHash = await depW.deployContract({ abi: [], bytecode: bc(zkTransArt), args: [], gas: 3_000_000n });
  const zkTransReceipt = await pub.waitForTransactionReceipt({ hash: zkTransHash });
  const ZK_TRANS_ADDR = zkTransReceipt.contractAddress!;
  console.log(`    ZKTranscriptLib @ ${ZK_TRANS_ADDR}`);

  const relationsHash = await depW.deployContract({ abi: [], bytecode: bc(relationsArt), args: [], gas: 5_000_000n });
  const relationsReceipt = await pub.waitForTransactionReceipt({ hash: relationsHash });
  const RELATIONS_ADDR = relationsReceipt.contractAddress!;
  console.log(`    RelationsLib    @ ${RELATIONS_ADDR}`);

  const libMap: Record<string, string> = {
    "contracts/verifiers/WithdrawVerifier.sol:ZKTranscriptLib": ZK_TRANS_ADDR,
    "contracts/verifiers/WithdrawVerifier.sol:RelationsLib":    RELATIONS_ADDR,
    "contracts/verifiers/TransferVerifier.sol:ZKTranscriptLib": ZK_TRANS_ADDR,
    "contracts/verifiers/TransferVerifier.sol:RelationsLib":    RELATIONS_ADDR,
  };

  const wvLinked = linkBytecode(wvArt.bytecode.object, wvArt.bytecode.linkReferences ?? {}, libMap);
  const tvLinked = linkBytecode(tvArt.bytecode.object, tvArt.bytecode.linkReferences ?? {}, libMap);

  const wvHash = await depW.deployContract({ abi: wvArt.abi as [], bytecode: wvLinked, args: [], gas: 10_000_000n });
  const wvReceipt = await pub.waitForTransactionReceipt({ hash: wvHash });
  const WV_ADDR = wvReceipt.contractAddress!;
  console.log(`    WithdrawVerifier @ ${WV_ADDR}`);

  const tvHash = await depW.deployContract({ abi: tvArt.abi as [], bytecode: tvLinked, args: [], gas: 10_000_000n });
  const tvReceipt = await pub.waitForTransactionReceipt({ hash: tvHash });
  const TV_ADDR = tvReceipt.contractAddress!;
  console.log(`    TransferVerifier @ ${TV_ADDR}`);

  const INITIAL_MAX_DEPOSIT      = 1_000_000n * 10n ** 6n;
  const INITIAL_MAX_POOL_BALANCE = 10_000_000n * 10n ** 6n;
  const poolHash = await depW.deployContract({
    abi: poolArt.abi as [],
    bytecode: bc(poolArt),
    args: [USDC_ADDR, WV_ADDR, TV_ADDR, deployerAcc.address, INITIAL_MAX_DEPOSIT, INITIAL_MAX_POOL_BALANCE],
    gas: 15_000_000n,
  });
  const poolReceipt = await pub.waitForTransactionReceipt({ hash: poolHash });
  if (poolReceipt.status !== "success") throw new Error(`PiiPool deployment failed: tx=${poolHash}`);
  const POOL_ADDR = poolReceipt.contractAddress!;
  if (!POOL_ADDR) throw new Error("PiiPool: no contractAddress in receipt");
  console.log(`    PiiPool @ ${POOL_ADDR} (gas=${poolReceipt.gasUsed})`);

  // 4. Start relayer
  console.log("\n[4] Starting relayer...");
  const relayerOwnerKey    = hash2(SK_RELAYER, 0n);
  const relayerSpendingKey = `0x${SK_RELAYER.toString(16).padStart(64, "0")}`;

  relayerProc = spawn("bun", ["run", "relayer/src/index.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      RELAYER_PRIVATE_KEY:  RELAYER_KEY,
      RELAYER_SPENDING_KEY: relayerSpendingKey,
      POOL_ADDRESS:         POOL_ADDR,
      RPC_URL,
      CHAIN_ID:    "31337",
      MIN_FEE:     "1000",
      PORT:        String(RELAYER_PORT),
    },
  });
  relayerProc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) console.error(`[relayer stderr] ${line}`);
  });
  await waitForRelayer();
  const info = await getRelayerInfo(RELAYER_URL);
  console.log(`    relayer address: ${info.relayerAddress}`);
  assert(info.chainId === 31337, "relayer chainId");
  assert(info.pool.toLowerCase() === POOL_ADDR.toLowerCase(), "relayer pool");

  // ── Derive user keys ────────────────────────────────────────────────────

  const OK_A = hash2(SK_A, 0n);
  const OK_B = hash2(SK_B, 0n);
  const viewA       = deriveViewingKeys(SK_A);
  const viewB       = deriveViewingKeys(SK_B);
  const viewRelayer = deriveViewingKeys(SK_RELAYER);
  const USDC_ID = hash2(BigInt(USDC_ADDR), 0n);

  // ── 5. User A: deposit 3 notes ──────────────────────────────────────────

  console.log("\n[5] User A deposits 3 notes...");

  const DEPOSIT_AMOUNTS  = [1_000_000n, 2_000_000n, 200_000n];
  const DEPOSIT_BLINDINGS = [101n, 202n, 303n];

  const poolAbi = parseAbi([
    "function deposit(uint256 amount, uint256 secret, bytes calldata memo) external",
    "function nullifierSpent(uint256) external view returns (bool)",
    "function isKnownRoot(uint256) external view returns (bool)",
    "event NewCommitment(uint256 indexed leafIndex, uint256 commitment, bytes memo)",
  ]);

  const totalDeposit = DEPOSIT_AMOUNTS.reduce((a, b) => a + b, 0n);
  const mintHash = await depW.writeContract({
    address: USDC_ADDR, abi: mockAbi, functionName: "mint",
    args: [userAAcc.address, totalDeposit + 1_000_000n],
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });

  const approveHash = await userAW.writeContract({
    address: USDC_ADDR, abi: mockAbi, functionName: "approve",
    args: [POOL_ADDR, totalDeposit + 1_000_000n],
  });
  await pub.waitForTransactionReceipt({ hash: approveHash });

  const depositNotes: Note[]  = [];
  const depositTxHashes: Hex[] = [];

  for (let i = 0; i < 3; i++) {
    const blinding = DEPOSIT_BLINDINGS[i];
    const secret   = hash2(OK_A, blinding);
    const note: Note = { assetId: USDC_ID, amount: DEPOSIT_AMOUNTS[i], ownerKey: OK_A, blinding };
    depositNotes.push(note);

    const memoSeed = new Uint8Array(32);
    memoSeed[31] = i + 1;
    const memoHex = encryptMemo(viewA.encPub, { amount: DEPOSIT_AMOUNTS[i], blinding, assetId: USDC_ID }, memoSeed);

    const depositHash = await userAW.writeContract({
      address: POOL_ADDR, abi: poolAbi, functionName: "deposit",
      args: [DEPOSIT_AMOUNTS[i], secret, memoHex],
      gas: 5_000_000n,
    });
    const r = await pub.waitForTransactionReceipt({ hash: depositHash });
    if (r.status !== "success") throw new Error(`deposit[${i}] failed: tx=${depositHash}`);
    // Verify the NewCommitment log was emitted in this receipt.
    const ncLogs = r.logs.filter(l => l.address.toLowerCase() === POOL_ADDR.toLowerCase());
    if (ncLogs.length === 0) throw new Error(`deposit[${i}]: no log emitted from pool (tx=${depositHash})`);
    depositTxHashes.push(depositHash);
    console.log(`    deposit[${i}] tx=${depositHash} gas=${r.gasUsed} poolLogs=${ncLogs.length}`);
  }

  // Allow anvil to finish indexing all deposit logs.
  // Anvil mines synchronously, but getLogs can transiently lag a block or two;
  // poll until we see all 3 NewCommitment events or 3 s elapses.
  {
    const ncEvent = {
      type: "event" as const,
      name: "NewCommitment",
      inputs: [
        { name: "leafIndex", type: "uint256", indexed: true  },
        { name: "commitment", type: "uint256", indexed: false },
        { name: "memo",       type: "bytes",   indexed: false },
      ],
    };
    for (let attempt = 0; attempt < 15; attempt++) {
      const h   = await pub.getBlockNumber();
      const lgs = await pub.getLogs({ address: POOL_ADDR, event: ncEvent, fromBlock: 0n, toBlock: h });
      if (lgs.length >= 3) break;
      await sleep(200);
    }
  }

  // ── Shared pool contract interface ──────────────────────────────────────

  const poolContractLike = {
    read: {
      isKnownRoot: ([root]: [bigint]) =>
        pub.readContract({ address: POOL_ADDR, abi: poolAbi, functionName: "isKnownRoot", args: [root] }),
      nullifierSpent: ([nf]: [bigint]) =>
        pub.readContract({ address: POOL_ADDR, abi: poolAbi, functionName: "nullifierSpent", args: [nf] }),
    },
  };

  // ── 6. User A: transfer to B via relayer ──────────────────────────────────

  console.log("\n[6] User A proves transfer to B (1_500_000, fee=50_000)...");

  // Sync tree — 3 leaves from the 3 deposits.
  const syncResult1: SyncResult = await syncTree(asPCL(pub), poolContractLike, POOL_ADDR, 0n);
  console.log(`    syncTree: ${syncResult1.leaves.length} leaves`);
  assert(syncResult1.leaves.length === 3, "tree has 3 leaves after deposits");

  // note[1]=2M@leaf1 as main input; note[0]=1M@leaf0 as fee note.
  const inNote0     = { ...depositNotes[1], leafIndex: 1 };
  const feeNote     = { ...depositNotes[0], leafIndex: 0 };
  const SEND_AMOUNT  = 1_500_000n;
  const RELAYER_FEE  = 50_000n;

  const recipientBlinding = 0xaabbccn;
  const changeBlinding    = 0xddeeffn;
  const feeOutBlinding    = 0x112233n;
  const feeChangeBlinding = 0x445566n;

  const transferMemos: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`] = [
    encryptMemo(viewB.encPub, { amount: SEND_AMOUNT,                          blinding: recipientBlinding, assetId: USDC_ID }, seedFrom(10n)),
    encryptMemo(viewA.encPub, { amount: inNote0.amount - SEND_AMOUNT,         blinding: changeBlinding,    assetId: USDC_ID }, seedFrom(11n)),
    encryptMemo(viewRelayer.encPub, { amount: RELAYER_FEE,                    blinding: feeOutBlinding,    assetId: USDC_ID }, seedFrom(12n)),
    encryptMemo(viewA.encPub, { amount: feeNote.amount - RELAYER_FEE,         blinding: feeChangeBlinding, assetId: USDC_ID }, seedFrom(13n)),
  ];

  const tResult = buildTransferInputs({
    sk: SK_A,
    inNotes:          [inNote0],
    feeNote,
    tree:             syncResult1.tree,
    leafIndices:      [1, 0],
    recipientOwnerKey: OK_B,
    sendAmount:       SEND_AMOUNT,
    fee:              RELAYER_FEE,
    relayerOwnerKey,
    relayer:          relayerAcc.address,
    memos:            transferMemos,
    pool:             POOL_ADDR,
    chainId:          CHAIN_ID,
    blindings:        { recipientBlinding, changeBlinding, feeOutBlinding, feeChangeBlinding },
  });

  console.log("    [transfer] proving...");
  const tProof = await proveTransfer(tResult.inputs);
  console.log(`    [transfer] proof=${tProof.proof.length}B`);

  const tRelayParams: TransferRelayParams = {
    proof:   `0x${Buffer.from(tProof.proof).toString("hex")}`,
    args: {
      root:            toHex64(tResult.publicInputs[0]),
      nf0:             toHex64(tResult.publicInputs[1]),
      nf1:             toHex64(tResult.publicInputs[2]),
      nfFee:           toHex64(tResult.publicInputs[3]),
      outRecipient:    toHex64(tResult.publicInputs[4]),
      outChange:       toHex64(tResult.publicInputs[5]),
      outFee:          toHex64(tResult.publicInputs[6]),
      outFeeChange:    toHex64(tResult.publicInputs[7]),
      eligibilityRoot: toHex64(tResult.publicInputs[8]),
      fee:             toHex64(tResult.publicInputs[9]),
      relayerOwnerKey: toHex64(tResult.publicInputs[10]),
    },
    relayer: relayerAcc.address,
    memos:   transferMemos,
    chainId: 31337,
    pool:    POOL_ADDR,
  };

  const transferTxResult = await relayTransfer(RELAYER_URL, tRelayParams);
  console.log(`    [transfer] tx=${transferTxResult.txHash} status=${transferTxResult.status}`);
  assert(transferTxResult.status === "confirmed", "transfer confirmed");

  const transferReceipt = await pub.getTransactionReceipt({ hash: transferTxResult.txHash });
  console.log(`    [transfer] gas=${transferReceipt.gasUsed}`);
  assert(
    transferReceipt.from.toLowerCase() === relayerAcc.address.toLowerCase(),
    "transfer: relayer is tx.from (not user A)",
  );
  assert(
    transferReceipt.from.toLowerCase() !== userAAcc.address.toLowerCase(),
    "transfer: user A is NOT tx.from",
  );

  // ── 7. User B: recoverWallet, withdraw ─────────────────────────────────────

  console.log("\n[7] User B recovers wallet and withdraws...");

  // Re-sync: now 3 deposits + 4 transfer outputs = 7 leaves.
  const syncResult2: SyncResult = await syncTree(asPCL(pub), poolContractLike, POOL_ADDR, 0n);
  console.log(`    syncTree: ${syncResult2.leaves.length} leaves`);
  assert(syncResult2.leaves.length === 7, "tree has 7 leaves after transfer");

  // recoverWallet accepts SyncResult directly (overload calls leavesWithMemos internally).
  const bStore = await recoverWallet(
    SK_B,
    { ownerKey: OK_B, encPriv: viewB.encPriv },
    syncResult2,
    poolContractLike,
  );
  const bNotes = bStore.unspent(USDC_ID);
  console.log(`    B found ${bNotes.length} unspent note(s): ${bNotes.map(n => `${n.amount}@leaf${n.leafIndex}`).join(", ")}`);
  assert(bNotes.length === 1, "B has exactly 1 unspent note");
  assert(bNotes[0].amount === SEND_AMOUNT, `B note amount = ${SEND_AMOUNT}`);

  const bNote = bNotes[0];
  const WITHDRAW_ADDR = "0x000000000000000000000000000000000000dEaD" as Hex;
  const WITHDRAW_FEE  = 1000n;
  // Full-note withdrawal: circuit amount = note.amount, change = 0 (ZERO_VALUE).
  // The pool contract deducts fee from amount and sends (amount - fee) to recipient.
  // Use dummyMemo() for the change memo slot — indistinguishable from a real one.
  const WITHDRAW_AMOUNT = SEND_AMOUNT; // what the circuit sees; fee comes out at the contract
  // Withdraw memo: 1 memo for the change note slot.
  // Full-note withdrawal → change = 0 → pool skips change insertion.
  // Use dummyMemo() so the size is identical to a real change memo (privacy).
  const wChangeMemo = dummyMemo(seedFrom(21n));

  const wResult = buildWithdrawInputs({
    sk:              SK_B,
    note:            bNote,
    tree:            syncResult2.tree,
    leafIndex:       bNote.leafIndex!,
    recipient:       WITHDRAW_ADDR,
    amount:          WITHDRAW_AMOUNT,
    relayer:         relayerAcc.address,
    fee:             WITHDRAW_FEE,
    memos:           [wChangeMemo],
    pool:            POOL_ADDR,
    chainId:         CHAIN_ID,
    changeBlinding:  0n,
  });

  console.log("    [withdraw] proving...");
  const wProof = await proveWithdraw(wResult.inputs);
  console.log(`    [withdraw] proof=${wProof.proof.length}B`);

  const wRelayParams: WithdrawRelayParams = {
    proof:            `0x${Buffer.from(wProof.proof).toString("hex")}`,
    root:             toHex64(wResult.publicInputs[0]),
    nullifier:        toHex64(wResult.publicInputs[1]),
    recipient:        WITHDRAW_ADDR,
    amount:           SEND_AMOUNT.toString(),
    changeCommitment: toHex64(wResult.publicInputs[4]),
    relayer:          relayerAcc.address,
    fee:              "1000",
    memos:            [wChangeMemo],
    chainId:          31337,
    pool:             POOL_ADDR,
  };

  const withdrawTxResult = await relayWithdraw(RELAYER_URL, wRelayParams);
  console.log(`    [withdraw] tx=${withdrawTxResult.txHash} status=${withdrawTxResult.status}`);
  assert(withdrawTxResult.status === "confirmed", "withdraw confirmed");

  const withdrawReceipt = await pub.getTransactionReceipt({ hash: withdrawTxResult.txHash });
  console.log(`    [withdraw] gas=${withdrawReceipt.gasUsed}`);
  assert(
    withdrawReceipt.from.toLowerCase() === relayerAcc.address.toLowerCase(),
    "withdraw: relayer is tx.from (not user B)",
  );
  assert(
    withdrawReceipt.from.toLowerCase() !== userBAcc.address.toLowerCase(),
    "withdraw: user B is NOT tx.from",
  );

  // ── 8. Relayer recovers its fee note ───────────────────────────────────────

  console.log("\n[8] Relayer recovers fee note...");
  const syncResult3: SyncResult = await syncTree(asPCL(pub), poolContractLike, POOL_ADDR, 0n);

  const rStore = await recoverWallet(
    SK_RELAYER,
    { ownerKey: relayerOwnerKey, encPriv: viewRelayer.encPriv },
    syncResult3,
    poolContractLike,
  );
  const rNotes = rStore.unspent(USDC_ID);
  console.log(`    Relayer found ${rNotes.length} fee note(s): ${rNotes.map(n => String(n.amount)).join(", ")}`);
  assert(rNotes.length >= 1, "relayer has at least 1 fee note");
  assert(rNotes[0].amount === RELAYER_FEE, `relayer fee note = ${RELAYER_FEE}`);

  // ── 9. Balance assertions ──────────────────────────────────────────────────

  console.log("\n[9] Balance assertions...");

  const deadBal = await pub.readContract({ address: USDC_ADDR, abi: mockAbi, functionName: "balanceOf", args: [WITHDRAW_ADDR] });
  console.log(`    0xdead balance: ${deadBal}`);
  // Withdraw amount minus relayer fee (1000) was sent out.
  // Contract sends (amount - fee) to recipient, fee to relayer.
  assert(deadBal === SEND_AMOUNT - WITHDRAW_FEE, `recipient received ${SEND_AMOUNT - WITHDRAW_FEE}`);

  // ── 10. Negative tests ─────────────────────────────────────────────────────

  console.log("\n[10] Negative tests...");

  /**
   * expectReject: asserts that fn() rejects.
   * Then asserts the thrown error message contains the expected HTTP status
   * code (as a string) AND the expected substring.
   * Throws — failing the E2E — if fn() resolves instead of rejects.
   */
  async function expectReject(
    label: string,
    fn: () => Promise<unknown>,
    httpStatus: number,
    substring: string,
  ): Promise<void> {
    let threw = false;
    let errMsg = "";
    try {
      await fn();
    } catch (e: unknown) {
      threw = true;
      errMsg = e instanceof Error ? e.message : String(e);
    }
    assert(threw, `[${label}] expected rejection but request was ACCEPTED`);
    assert(
      errMsg.includes(String(httpStatus)),
      `[${label}] expected HTTP ${httpStatus} in error; got: "${errMsg}"`,
    );
    assert(
      errMsg.toLowerCase().includes(substring.toLowerCase()),
      `[${label}] expected "${substring}" in error; got: "${errMsg}"`,
    );
    console.log(`    PASS: ${label}`);
  }

  // 10a. Bad memo length (3-byte memo)
  // Relayer: 400 "memo must be 134 bytes"
  await expectReject(
    "short memo rejected",
    () => relayTransfer(RELAYER_URL, {
      ...tRelayParams,
      memos: ["0xaabbcc", ...tRelayParams.memos.slice(1)],
    }),
    400,
    "memo must be",
  );

  // 10b. Wrong relayerOwnerKey
  // Relayer: 400 "relayerOwnerKey mismatch"
  await expectReject(
    "wrong relayerOwnerKey rejected",
    () => relayTransfer(RELAYER_URL, {
      ...tRelayParams,
      args: { ...tRelayParams.args, relayerOwnerKey: toHex64(0xdeadbeefn) },
    }),
    400,
    "relayerOwnerKey mismatch",
  );

  // 10c. Fee below minFee (MIN_FEE = 1000; send 1)
  // Relayer: 400 "fee too low: min 1000"
  await expectReject(
    "fee below minFee rejected",
    () => relayTransfer(RELAYER_URL, {
      ...tRelayParams,
      args: { ...tRelayParams.args, fee: toHex64(1n) },
    }),
    400,
    "fee too low",
  );

  // 10d. Replay (nf0 already spent on-chain)
  // Relayer: 409 "nullifier already spent"
  await expectReject(
    "replayed proof rejected",
    () => relayTransfer(RELAYER_URL, tRelayParams),
    409,
    "nullifier already spent",
  );

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log("\n=== E2E PASSED ===\n");
  console.log("Tx hashes:");
  depositTxHashes.forEach((h, i) => console.log(`  deposit[${i}]: ${h}`));
  console.log(`  transfer:  ${transferTxResult.txHash}  gas=${transferReceipt.gasUsed}`);
  console.log(`  withdraw:  ${withdrawTxResult.txHash}  gas=${withdrawReceipt.gasUsed}`);
}

main()
  .catch(e => {
    console.error("\n[FAIL]", e);
    process.exit(1);
  })
  .finally(() => {
    anvilProc?.kill();
    relayerProc?.kill();
  });
