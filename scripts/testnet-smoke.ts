#!/usr/bin/env bun
/**
 * scripts/testnet-smoke.ts
 *
 * Frontend smoke-test: exercises the same pii-ops.ts functions used by the UI.
 *
 * Flow:
 *   1. Start relayer
 *   2. User A: deposit 0.1 USDC send note, then ensureFeeNotes(1) to get a fee note
 *   3. User A: prove + relay transfer → User B (0.05 USDC)
 *   4. User B: recover note, prove + relay withdraw (0.05 USDC minus fee → deployer)
 *   5. Assert tx.from == relayer for steps 3 and 4
 *   6. Assert User B recovered balance is correct
 *   7. Print explorer links
 *
 * Run:  bun run smoke:testnet
 * Env:  TESTNET_DEPLOYER_KEY and TESTNET_RELAYER_KEY in .env or env/.env
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseAbiItem,
  decodeEventLog,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// SDK — direct paths (bun resolves tsconfig @sdk alias; also works raw)
import { type PoolContractLike } from "../sdk/src/tree.js";
import { deriveViewingKeys, encryptMemo }  from "../sdk/src/memo.js";
import { recoverWallet }                   from "../sdk/src/wallet.js";
import { depositSecret, randomBlinding }   from "../sdk/src/note.js";
import { proveWithdraw, proveTransfer }    from "../sdk/src/prover.js";
import { getRelayerInfo, relayTransfer, relayWithdraw, waitForStatus } from "../sdk/src/relayer.js";
import { ARC_TESTNET }                     from "../sdk/src/config.js";
import { hash2 }                           from "../sdk/src/hash.js";

// pii-ops: the SAME functions used by the UI
import { prepareTransfer, prepareWithdraw, USDC_ID, FEE_NOTE_AMOUNT } from "../src/lib/pii-ops.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ROOT         = join((import.meta as unknown as { dir: string }).dir, "..");
const RELAYER_PORT = 3004;
const RELAYER_URL  = `http://127.0.0.1:${RELAYER_PORT}`;
const CHAIN_ID     = BigInt(ARC_TESTNET.chainId);

const EXPLORER = ARC_TESTNET.explorer;
const txLink   = (h: string) => `${EXPLORER}/tx/${h}`;

// Test spending keys — derived from block number so each run uses fresh keys
// (avoids nullifier-already-spent errors from cross-run note collisions)
// We read blockNum later in main(); compute SKs there from it.

const USDC_ADDR = ARC_TESTNET.usdc;
const POOL_ADDR = ARC_TESTNET.pool;

const DEPOSIT_SEND = 100_000n;  // 0.10 USDC  (main send note)
const SEND_AMOUNT  =  50_000n;  // 0.05 USDC  pay to B
const RELAY_FEE    =   1_000n;  // 0.001 USDC relayer fee for transfer
const WITHDRAW_FEE =     200n;  // 0.0002 USDC relayer fee for withdraw

const POOL_ABI = parseAbi([
  "function deposit(uint256 amount, uint256 secret, bytes memo) nonpayable",
  "function nullifierSpent(uint256) view returns (bool)",
  "function isKnownRoot(uint256) view returns (bool)",
  "function currentPoolBalance() view returns (uint256)",
  "function maxPoolBalance() view returns (uint256)",
]);
const USDC_ABI_PARSED = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function pass(msg: string): void { console.log(`  ✓ ${msg}`); }


function makePoolContract(c: ReturnType<typeof createPublicClient>): PoolContractLike {
  return {
    read: {
      isKnownRoot: async (args: readonly [bigint]) =>
        c.readContract({ address: POOL_ADDR, abi: POOL_ABI, functionName: "isKnownRoot", args: [args[0]] }),
    },
  };
}

// ── Load env ──────────────────────────────────────────────────────────────────

const envPath = existsSync(join(ROOT, "env", ".env"))
  ? join(ROOT, "env", ".env")
  : join(ROOT, ".env");
if (!existsSync(envPath)) throw new Error(".env not found — run deploy-arc-testnet.ts first");

const envContent = readFileSync(envPath, "utf8");
function envVar(name: string): string {
  const m = envContent.match(new RegExp(`^${name}=(.+)$`, "m"));
  if (!m) throw new Error(`Missing ${name} in .env`);
  return m[1].trim();
}

const DEPLOYER_KEY = envVar("TESTNET_DEPLOYER_KEY") as Hex;
const RELAYER_KEY  = envVar("TESTNET_RELAYER_KEY")  as Hex;

// ── Relayer process ───────────────────────────────────────────────────────────

async function startRelayer(): Promise<ChildProcess> {
  const rEnv: NodeJS.ProcessEnv = {
    ...process.env,
    RELAYER_PRIVATE_KEY:  RELAYER_KEY,
    RELAYER_SPENDING_KEY: RELAYER_KEY,
    POOL_ADDRESS:         POOL_ADDR,
    RPC_URL:              ARC_TESTNET.rpcUrl,
    CHAIN_ID:             String(ARC_TESTNET.chainId),
    MIN_FEE:              "100",
    PORT:                 String(RELAYER_PORT),
    RATE_LIMIT_RPM:       "120",
  };
  const proc = spawn("bun", ["run", join(ROOT, "relayer/src/index.ts")], {
    env: rEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[relayer] ${d.toString()}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[relayer] ${d.toString()}`));
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try { const r = await fetch(`${RELAYER_URL}/info`); if (r.ok) { console.log("  relayer ready"); return proc; } }
    catch { /* not yet */ }
  }
  throw new Error("Relayer did not start within 15 s");
}

// ── Deposit helper (replicates DepositTab's logic) ────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWriteContract = (args: any) => Promise<Hex>

async function depositNote(opts: {
  amount:   bigint
  ownerKey: bigint
  encPub:   Uint8Array
  pub:      ReturnType<typeof createPublicClient>
  write:    AnyWriteContract
  uniqueSalt?: bigint
}): Promise<Hex> {
  const { amount, ownerKey, encPub, pub, write, uniqueSalt = 0n } = opts;
  const blinding = randomBlinding() ^ uniqueSalt;
  const secret   = depositSecret(ownerKey, blinding);
  const memo     = encryptMemo(encPub, { assetId: USDC_ID, amount, blinding });

  const approveTx = await write({ address: USDC_ADDR, abi: USDC_ABI_PARSED, functionName: "approve", args: [POOL_ADDR, amount] });
  await pub.waitForTransactionReceipt({ hash: approveTx });

  const depositTx = await write({ address: POOL_ADDR, abi: POOL_ABI, functionName: "deposit", args: [amount, secret, memo] });
  await pub.waitForTransactionReceipt({ hash: depositTx });
  return depositTx;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== Pii Testnet Smoke Test ===\n");

  const deployerAccount = privateKeyToAccount(DEPLOYER_KEY);
  const pub = createPublicClient({ chain: arcTestnet, transport: http(ARC_TESTNET.rpcUrl) });
  const wal = createWalletClient({ account: deployerAccount, chain: arcTestnet, transport: http(ARC_TESTNET.rpcUrl) });

  const blockNum = await pub.getBlockNumber();
  console.log(`Chain: Arc Testnet | Block: ${blockNum}`);

  // Per-run unique spending keys: base + block ensures no nullifier collisions across runs.
  // Use a large base to avoid any overlap with testnet-e2e.ts keys (111222333444555 / 999888777666555).
  const SK_A = 900_000_000_000_000n + blockNum;
  const SK_B = 800_000_000_000_000n + blockNum;

  const ownerKeyA = hash2(SK_A, 0n);
  const ownerKeyB = hash2(SK_B, 0n);
  const viewA     = deriveViewingKeys(SK_A);
  const viewB     = deriveViewingKeys(SK_B);

  // ── [1/5] Start relayer ───────────────────────────────────────────────────
  console.log("\n[1/5] Starting relayer...");
  const relayerProc = await startRelayer();

  try {
    const info = await getRelayerInfo(RELAYER_URL);
    console.log(`  relayer: ${info.relayerAddress}`);

    // ── [2/5] Deposit send note + ensure fee note ─────────────────────────
    console.log("\n[2/5] Depositing send note (0.1 USDC) + fee note (0.02 USDC)...");
    await sleep(1_000); // brief pause after relayer startup to avoid rate limit burst

    // Wrap walletClient.writeContract for depositNote
    const write: AnyWriteContract = (args) => wal.writeContract(args as Parameters<typeof wal.writeContract>[0]);

    const depositSendTx = await depositNote({
      amount: DEPOSIT_SEND, ownerKey: ownerKeyA, encPub: viewA.encPub,
      pub, write, uniqueSalt: blockNum,
    });
    pass(`Send note deposited: ${txLink(depositSendTx)}`);

    // Direct fee-note deposit (same path as ensureFeeNotes in the UI)
    const depositFeeTx = await depositNote({
      amount: FEE_NOTE_AMOUNT, ownerKey: ownerKeyA, encPub: viewA.encPub,
      pub, write, uniqueSalt: blockNum + 1n,
    });
    pass(`Fee note deposited:  ${txLink(depositFeeTx)}`);

    // ── [3/5] User A sync + select notes ─────────────────────────────────
    console.log("\n[3/5] Syncing tree + recovering User A's wallet...");
    const poolCtx = makePoolContract(pub);

    // Scan from deploy block (required for consistent Merkle tree).
    // Retry on rate-limit errors with exponential backoff.
    const scanFrom = BigInt(ARC_TESTNET.deployBlock);
    // syncWithRetry: wraps syncTree with throttling between 10k-block chunks.
    // Inserts a 1.5s sleep between each chunk call to stay within Arc Testnet RPC limits.
    // Falls back to 30s retry on rate-limit errors.
    // syncWithRetry: manually batches eth_getLogs with 1.5s sleep between chunks
    // to avoid Arc Testnet public RPC rate limits.
    async function syncWithRetry(from: bigint) {
      const CHUNK = 10_000n;
      const head  = await pub.getBlockNumber();
      const allLeaves: Array<{ leafIndex: bigint; commitment: bigint; memo: string }> = [];
      const allMemos = new Map<number, `0x${string}`>();

      for (let chunkStart = from; chunkStart <= head; chunkStart += CHUNK) {
        const chunkEnd = chunkStart + CHUNK - 1n < head ? chunkStart + CHUNK - 1n : head;
        let rawLogs: Awaited<ReturnType<typeof pub.getLogs>> = [];
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            rawLogs = await pub.getLogs({
              address: POOL_ADDR,
              event: parseAbiItem('event NewCommitment(uint256 indexed leafIndex, uint256 commitment, bytes memo)'),
              fromBlock: chunkStart,
              toBlock:   chunkEnd,
            });
            break;
          } catch (e: unknown) {
            const msg = String(e);
            if (msg.includes('rate limit') || msg.includes('exceeds defined limit')) {
              const delay = 5_000 * (attempt + 1);
              console.log(`  RPC rate limit on chunk, retry in ${delay}ms...`);
              await sleep(delay);
            } else throw e;
          }
        }
        for (const raw of rawLogs) {
          const d = decodeEventLog({
            abi: [parseAbiItem('event NewCommitment(uint256 indexed leafIndex, uint256 commitment, bytes memo)')],
            data: raw.data,
            topics: raw.topics,
          });
          const { leafIndex, commitment, memo } = d.args as { leafIndex: bigint; commitment: bigint; memo: string };
          allLeaves.push({ leafIndex, commitment, memo });
          allMemos.set(Number(leafIndex), memo as `0x${string}`);
        }
        if (chunkStart + CHUNK <= head) await sleep(1_500);
      }

      const { buildTree } = await import('../sdk/src/tree.js');
      allLeaves.sort((a, b) => Number(a.leafIndex - b.leafIndex));
      for (let i = 0; i < allLeaves.length; i++) {
        if (Number(allLeaves[i].leafIndex) !== i) {
          throw new Error(`syncWithRetry: gap at index ${i}, got leafIndex ${allLeaves[i].leafIndex}`);
        }
      }
      const commitments = allLeaves.map(l => l.commitment);
      const tree = buildTree(commitments);
      const known = await poolCtx.read.isKnownRoot([tree.root]);
      if (!known) throw new Error('syncWithRetry: computed root not known by pool');
      const memosByIndex = new Map(allMemos);
      return { tree, leaves: commitments, memosByIndex };
    }

    let srA = await syncWithRetry(scanFrom);
    for (let r = 0; r < 6 && srA.leaves.length === 0; r++) {
      await sleep(500);
      srA = await syncWithRetry(scanFrom);
    }

    const storeA = await recoverWallet(SK_A, { ownerKey: ownerKeyA, encPriv: viewA.encPriv }, srA, {
      read: {
        nullifierSpent: async (args: [bigint]) => {
          const spent = await pub.readContract({ address: POOL_ADDR, abi: POOL_ABI, functionName: "nullifierSpent", args: [args[0]] });
          return Boolean(spent);
        },
      },
    });

    const unspentA = storeA.unspent();
    assert(unspentA.length >= 2, `Expected ≥2 unspent notes for A, got ${unspentA.length}`);
    const sortedA = [...unspentA].sort((a, b) => Number(b.amount - a.amount));
    // inNote = largest, feeNote = second-largest (or any with leafIndex != inNote)
    const inNote  = sortedA[0];
    const feeNote = sortedA.slice(1).find(n => n.amount >= RELAY_FEE);
    assert(!!feeNote, "No eligible fee note found");
    assert(inNote.amount >= SEND_AMOUNT, `inNote too small: ${inNote.amount}`);
    pass(`inNote=${Number(inNote.amount)/1e6} USDC  feeNote=${Number(feeNote!.amount)/1e6} USDC`);

    // ── [4/5] Transfer A→B ────────────────────────────────────────────────
    console.log("\n[4/5] User A pays 0.05 USDC to User B (via relayer)...");

    const prep = prepareTransfer({
      sk:               SK_A,
      encPub:           viewA.encPub,
      inNote,
      feeNote:          feeNote!,
      tree:             srA.tree,
      sendAmount:       SEND_AMOUNT,
      fee:              RELAY_FEE,
      relayerAddr:      info.relayerAddress,
      relayerOwnerKey:  BigInt(info.relayerOwnerKey),
      recipientOwnerKey: ownerKeyB,
      recipientEncPub:  viewB.encPub,
      chainId:          CHAIN_ID,
    });

    const transferProof = await proveTransfer(prep.inputs);
    prep.relayParams.proof = `0x${Buffer.from(transferProof.proof).toString("hex")}`;

    const transferResult = await relayTransfer(RELAYER_URL, prep.relayParams);
    const transferStatus = await waitForStatus(RELAYER_URL, transferResult.txHash, { timeoutMs: 90_000 });
    assert(transferStatus === "confirmed", `Transfer not confirmed: ${transferStatus}`);

    const transferTx = await pub.getTransaction({ hash: transferResult.txHash });
    assert(
      transferTx.from.toLowerCase() === info.relayerAddress.toLowerCase(),
      `tx.from expected ${info.relayerAddress}, got ${transferTx.from}`,
    );
    pass(`Transfer confirmed: ${txLink(transferResult.txHash)}`);
    pass(`tx.from = relayer — VERIFIED`);

    // ── [5/5] User B recover + withdraw ──────────────────────────────────
    console.log("\n[5/5] User B recovers note and withdraws (via relayer)...");
    await sleep(2_000);

    let srB = await syncWithRetry(scanFrom);
    const storeB = await recoverWallet(SK_B, { ownerKey: ownerKeyB, encPriv: viewB.encPriv }, srB, {
      read: {
        nullifierSpent: async (args: [bigint]) => {
          const spent = await pub.readContract({ address: POOL_ADDR, abi: POOL_ABI, functionName: "nullifierSpent", args: [args[0]] });
          return Boolean(spent);
        },
      },
    });

    const unspentB = storeB.unspent();
    assert(unspentB.length > 0, "User B: no unspent notes");
    const bNote = unspentB.find(n => n.amount >= WITHDRAW_FEE);
    assert(!!bNote, "User B: note too small for withdraw fee");

    // Assert balance: B should have SEND_AMOUNT
    assert(bNote!.amount === SEND_AMOUNT, `B note amount ${bNote!.amount} !== ${SEND_AMOUNT}`);
    pass(`User B recovered ${formatAtoms(bNote!.amount)} USDC — balance correct`);

    // Re-sync for B's withdraw (tree must include transfer leaf)
    srB = await syncWithRetry(scanFrom);

    const wPrep = prepareWithdraw({
      sk:          SK_B,
      note:        bNote!,
      tree:        srB,
      amount:      bNote!.amount - WITHDRAW_FEE,
      fee:         WITHDRAW_FEE,
      relayerAddr: info.relayerAddress,
      recipient:   deployerAccount.address,
      chainId:     CHAIN_ID,
    });

    const withdrawProof = await proveWithdraw(wPrep.inputs);
    wPrep.relayParams.proof = `0x${Buffer.from(withdrawProof.proof).toString("hex")}`;

    const withdrawResult = await relayWithdraw(RELAYER_URL, wPrep.relayParams);
    const withdrawStatus = await waitForStatus(RELAYER_URL, withdrawResult.txHash, { timeoutMs: 90_000 });
    assert(withdrawStatus === "confirmed", `Withdraw not confirmed: ${withdrawStatus}`);

    const withdrawTx = await pub.getTransaction({ hash: withdrawResult.txHash });
    assert(
      withdrawTx.from.toLowerCase() === info.relayerAddress.toLowerCase(),
      `tx.from expected ${info.relayerAddress}, got ${withdrawTx.from}`,
    );
    pass(`Withdraw confirmed: ${txLink(withdrawResult.txHash)}`);
    pass(`tx.from = relayer — VERIFIED`);

    // ── Results ────────────────────────────────────────────────────────────
    console.log("\n=== PASS ===\n");
    console.log("Explorer links:");
    console.log(`  Send note deposit: ${txLink(depositSendTx)}`);
    console.log(`  Fee note deposit:  ${txLink(depositFeeTx)}`);
    console.log(`  Transfer (pay):    ${txLink(transferResult.txHash)}`);
    console.log(`  Withdraw:          ${txLink(withdrawResult.txHash)}`);

  } finally {
    relayerProc.kill();
  }
}

function formatAtoms(a: bigint): string {
  const s = a.toString().padStart(7, "0");
  return `${s.slice(0, -6) || "0"}.${s.slice(-6, -4)}`;
}

main().catch((err: unknown) => {
  console.error("\n=== FAIL ===");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
