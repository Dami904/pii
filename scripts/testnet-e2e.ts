#!/usr/bin/env bun
/**
 * scripts/testnet-e2e.ts
 *
 * End-to-end test on Arc Testnet — mirrors anvil-e2e.ts but uses the live
 * chain and the contracts recorded in deployments/arc-testnet.json.
 *
 * Prerequisites:
 *   - deployments/arc-testnet.json exists (run deploy-arc-testnet.ts first)
 *   - TESTNET_DEPLOYER_KEY  — funds user A for the test (loaded from .env)
 *   - TESTNET_RELAYER_KEY   — used for the local relayer (loaded from .env)
 *   - Forge build is current (contracts/out/ up to date)
 *
 * Flow:
 *   0.  Load deployment record.
 *   1.  Derive test keys (SK_A, SK_B, SK_RELAYER from well-known ints — same
 *       technique as anvil-e2e, no real funds at risk from exposing SKs).
 *   2.  Fund user A from deployer (tiny amounts).
 *   3.  Start relayer locally, pointed at testnet.
 *   4.  User A deposits 3 notes (0.5, 0.3, 0.2 USDC).
 *   5.  User A proves transfer to B (0.3 USDC, fee = 500 base units).
 *   6.  User B recoverWallet from chain, proves withdraw to fresh address.
 *   7.  Relayer recovers its fee note.
 *   8.  Balance assertions.
 *   9.  Negative tests.
 *  10.  Print explorer links.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { arcTestnet } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, openSync } from "node:fs";
import { join } from "node:path";

import {
  syncTree,
  leavesWithMemos,
  type SyncResult,
  type PublicClientLike,
} from "../sdk/src/tree.js";
import { randomBlinding } from "../sdk/src/note.js";
import type { Note } from "../sdk/src/note.js";
import { hash2, ZERO_VALUE } from "../sdk/src/hash.js";
import { buildWithdrawInputs, buildTransferInputs } from "../sdk/src/inputs.js";
import { proveWithdraw, proveTransfer } from "../sdk/src/prover.js";
import { encryptMemo, dummyMemo, deriveViewingKeys } from "../sdk/src/memo.js";
import { recoverWallet } from "../sdk/src/wallet.js";
import { relayWithdraw, relayTransfer, getRelayerInfo } from "../sdk/src/relayer.js";
import type { TransferRelayParams, WithdrawRelayParams } from "../sdk/src/relayer.js";

void leavesWithMemos; void randomBlinding; void ZERO_VALUE;

// ── Constants ──────────────────────────────────────────────────────────────

const ROOT        = join((import.meta as unknown as { dir: string }).dir, "..");
const RELAYER_PORT = 3003;
const RELAYER_URL  = `http://127.0.0.1:${RELAYER_PORT}`;
const CHAIN_ID     = BigInt(arcTestnet.id); // 5042002

// Explorer
const EXPLORER = "https://explorer.testnet.arc.io";
const txLink   = (h: string) => `${EXPLORER}/tx/${h}`;
const addrLink = (a: string) => `${EXPLORER}/address/${a}`;

// Test spending keys (arbitrary; no real funds)
const SK_A       = 111222333444555n;
const SK_B       = 999888777666555n;
const SK_RELAYER = 123456789012345n;

// USDC on Arc Testnet (native + ERC-20 unified)
const USDC_ADDR = "0x3600000000000000000000000000000000000000" as Hex;

// Deposit amounts in base units (6 decimals):  0.5, 0.3, 0.2 USDC
const DEPOSIT_AMOUNTS  = [500_000n, 300_000n, 200_000n];
// Blindings include the block number so deposits are unique even across re-runs
// resolved after chain connection; populated in main()
const DEPOSIT_BLINDINGS: bigint[] = [];

const SEND_AMOUNT  = 300_000n;   // 0.3 USDC  (= note at index 0)
const RELAYER_FEE  = 500n;       // 0.0005 USDC (relayer fee for transfer)
const WITHDRAW_FEE = 100n;       // 0.0001 USDC (relayer fee for withdraw)

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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

function asPCL(client: ReturnType<typeof createPublicClient>): PublicClientLike {
  return client as unknown as PublicClientLike;
}

async function waitForRelayer(retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${RELAYER_URL}/info`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  throw new Error("relayer did not start in time");
}

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

// ── Main ────────────────────────────────────────────────────────────────────

let relayerProc: ChildProcess | null = null;

async function main() {
  // ── 0. Load deployment record ──────────────────────────────────────────────

  const deployPath = join(ROOT, "deployments/arc-testnet.json");
  if (!existsSync(deployPath)) {
    throw new Error(
      "deployments/arc-testnet.json not found. Run `bun run scripts/deploy-arc-testnet.ts` first."
    );
  }
  const deploy = JSON.parse(readFileSync(deployPath, "utf-8")) as {
    chainId: number;
    deployBlock: number;
    contracts: {
      PiiPool:          { address: Hex };
      PiiKeyRegistry:   { address: Hex };
      WithdrawVerifier: { address: Hex };
      TransferVerifier: { address: Hex };
    };
    explorer: string;
  };

  assert(deploy.chainId === Number(CHAIN_ID), `deployment chainId ${deploy.chainId} !== ${CHAIN_ID}`);
  const POOL_ADDR     = deploy.contracts.PiiPool.address;
  const DEPLOY_BLOCK  = BigInt(deploy.deployBlock);

  console.log(`\n=== Pii testnet E2E (Arc Testnet chainId=${CHAIN_ID}) ===`);
  console.log(`PiiPool:  ${addrLink(POOL_ADDR)}`);
  console.log(`Sync from block ${DEPLOY_BLOCK}`);

  // ── Load keys ──────────────────────────────────────────────────────────────

  const deployerKey  = process.env.TESTNET_DEPLOYER_KEY as Hex | undefined;
  const relayerKey   = process.env.TESTNET_RELAYER_KEY  as Hex | undefined;
  if (!deployerKey)  throw new Error("TESTNET_DEPLOYER_KEY not set in .env");
  if (!relayerKey)   throw new Error("TESTNET_RELAYER_KEY not set in .env");

  const deployerAcc  = privateKeyToAccount(deployerKey);
  const relayerAcc   = privateKeyToAccount(relayerKey);

  // Fresh deterministic user EOAs (derived from test spending keys)
  // These are NOT the spending keys — they're separate EOA signing keys for
  // submitting deposit transactions only.
  const userAAcc = privateKeyToAccount((`0x${SK_A.toString(16).padStart(64, "0")}`));
  const userBAcc = privateKeyToAccount((`0x${SK_B.toString(16).padStart(64, "0")}`));

  const pub  = createPublicClient({ chain: arcTestnet, transport: http() });
  const depW = createWalletClient({ account: deployerAcc, chain: arcTestnet, transport: http() });
  const userAW = createWalletClient({ account: userAAcc, chain: arcTestnet, transport: http() });

  // Unique blindings per run: mix in the current block number
  const startBlock = await pub.getBlockNumber();
  DEPOSIT_BLINDINGS.push(startBlock + 101n, startBlock + 202n, startBlock + 303n);

  // ── 1. Check/fund user A ───────────────────────────────────────────────────

  console.log("\n[1] Funding user A from deployer...");
  const usdcAbi = parseAbi([
    "function balanceOf(address) external view returns (uint256)",
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function approve(address spender, uint256 amount) external returns (bool)",
  ]);

  const totalNeeded = DEPOSIT_AMOUNTS.reduce((a, b) => a + b, 0n) + 2_000_000n; // buffer
  const userABal = await pub.readContract({ address: USDC_ADDR, abi: usdcAbi, functionName: "balanceOf", args: [userAAcc.address] });
  if ((userABal) < totalNeeded) {
    const toFund = totalNeeded - (userABal);
    console.log(`  Sending ${toFund} USDC base units to user A (${userAAcc.address})...`);
    const fundHash = await depW.writeContract({ address: USDC_ADDR, abi: usdcAbi, functionName: "transfer", args: [userAAcc.address, toFund] });
    await pub.waitForTransactionReceipt({ hash: fundHash });
    console.log(`  funded: ${txLink(fundHash)}`);
  }

  // Fund user A's EOA with some USDC for gas (Arc Testnet: USDC = gas)
  // The deployer also needs to send a tiny amount for the deposit transactions' gas
  // (handled by the pool's approval flow — actually user A pays gas from USDC).
  // Arc Testnet USDC IS the gas token, so transferring USDC to user A is sufficient.

  console.log(`  user A (${userAAcc.address}): ready`);

  // ── Derive Pii keys ────────────────────────────────────────────────────────

  const OK_A = hash2(SK_A, 0n);
  const OK_B = hash2(SK_B, 0n);
  const viewA       = deriveViewingKeys(SK_A);
  const viewB       = deriveViewingKeys(SK_B);
  const viewRelayer = deriveViewingKeys(SK_RELAYER);
  const USDC_ID     = hash2(BigInt(USDC_ADDR), 0n);
  const relayerOwnerKey = hash2(SK_RELAYER, 0n);
  const relayerSpendingKey = `0x${SK_RELAYER.toString(16).padStart(64, "0")}`;

  // ── 2. Start relayer ───────────────────────────────────────────────────────

  console.log("\n[2] Starting relayer (local, pointed at testnet)...");
  // Kill any stale relayer on this port
  try { execSync("pkill -9 -f 'relayer/src/index' 2>/dev/null; true", { shell: "/bin/sh" }); } catch { /* ok */ }
  await sleep(600);

  const relayerLogPath = "/tmp/testnet-relayer.log";
  const relayerLogFd  = openSync(relayerLogPath, "w");
  relayerProc = spawn("bun", ["run", "relayer/src/index.ts"], {
    cwd: ROOT,
    stdio: ["ignore", relayerLogFd, relayerLogFd],
    env: {
      ...process.env,
      RELAYER_PRIVATE_KEY:  relayerKey,
      RELAYER_SPENDING_KEY: relayerSpendingKey,
      POOL_ADDRESS:         POOL_ADDR,
      RPC_URL:              arcTestnet.rpcUrls.default.http[0],
      CHAIN_ID:             String(CHAIN_ID),
      MIN_FEE:              "100",
      PORT:                 String(RELAYER_PORT),
    },
  });
  console.log(`  relayer log: ${relayerLogPath}`);
  await waitForRelayer();
  const info = await getRelayerInfo(RELAYER_URL);
  console.log(`  relayer: ${info.relayerAddress}  chainId=${info.chainId}`);
  assert(info.chainId === Number(CHAIN_ID), "relayer chainId matches");
  assert(info.pool.toLowerCase() === POOL_ADDR.toLowerCase(), "relayer pool matches");

  // ── Pool contract interface ────────────────────────────────────────────────

  const poolAbi = parseAbi([
    "function deposit(uint256 amount, uint256 secret, bytes calldata memo) external",
    "function nullifierSpent(uint256) external view returns (bool)",
    "function isKnownRoot(uint256) external view returns (bool)",
    "event NewCommitment(uint256 indexed leafIndex, uint256 commitment, bytes memo)",
  ]);

  const poolContractLike = {
    read: {
      isKnownRoot: ([root]: [bigint]) =>
        pub.readContract({ address: POOL_ADDR, abi: poolAbi, functionName: "isKnownRoot", args: [root] }),
      nullifierSpent: ([nf]: [bigint]) =>
        pub.readContract({ address: POOL_ADDR, abi: poolAbi, functionName: "nullifierSpent", args: [nf] }),
    },
  };

  // ── 3. User A: approve + deposit 3 notes ──────────────────────────────────

  console.log("\n[3] User A approves USDC and deposits 3 notes...");

  // Approve pool to spend USDC
  const totalDeposit = DEPOSIT_AMOUNTS.reduce((a, b) => a + b, 0n);
  const approveHash = await userAW.writeContract({
    address: USDC_ADDR, abi: usdcAbi, functionName: "approve",
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
    const r = await pub.waitForTransactionReceipt({ hash: depositHash, confirmations: 1 });
    if (r.status !== "success") throw new Error(`deposit[${i}] failed: ${depositHash}`);
    depositTxHashes.push(depositHash);
    console.log(`  deposit[${i}] ${Number(DEPOSIT_AMOUNTS[i])/1e6} USDC  ${txLink(depositHash)}`);
  }

  // Allow RPC to index events
  const ncEvent = {
    type: "event" as const,
    name: "NewCommitment",
    inputs: [
      { name: "leafIndex", type: "uint256", indexed: true  },
      { name: "commitment", type: "uint256", indexed: false },
      { name: "memo",       type: "bytes",   indexed: false },
    ],
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const h   = await pub.getBlockNumber();
    const lgs = await pub.getLogs({ address: POOL_ADDR, event: ncEvent, fromBlock: DEPLOY_BLOCK, toBlock: h });
    if (lgs.length >= 3) break;
    await sleep(400);
  }

  // ── 4. Sync + transfer ─────────────────────────────────────────────────────

  console.log("\n[4] User A proves transfer to B...");

  const syncResult1: SyncResult = await syncTree(asPCL(pub), poolContractLike, POOL_ADDR, DEPLOY_BLOCK);
  console.log(`  syncTree: ${syncResult1.leaves.length} leaves`);
  assert(syncResult1.leaves.length >= 3, "at least 3 leaves after deposits");

  // Scan to find A's notes (handles pre-existing leaves from prior runs)
  const { scanNotes } = await import("../sdk/src/memo.js");
  const { nullifier: computeNullifier } = await import("../sdk/src/note.js");
  const allANotes = scanNotes(OK_A, viewA.encPriv, leavesWithMemos(syncResult1));
  // Filter to unspent (check each nullifier)
  const unspentANotes: typeof allANotes = [];
  for (const n of allANotes) {
    const nullifierVal = computeNullifier(n, SK_A);
    const spent = await poolContractLike.read.nullifierSpent([nullifierVal]);
    if (!spent) unspentANotes.push(n);
  }
  console.log(`  A found ${unspentANotes.length} unspent notes`);
  assert(unspentANotes.length >= 2, "A has at least 2 unspent notes (main + fee input)");

  // Sort descending by amount, use largest two as inNote0 and feeNote
  const sortedA = [...unspentANotes].sort((a, b) => (b.amount > a.amount ? 1 : -1));
  const inNote0 = sortedA[0];
  const feeNote = sortedA[1];

  const recipientBlinding = 0xaabbccn;
  const changeBlinding    = 0xddeeffn;
  const feeOutBlinding    = 0x112233n;
  const feeChangeBlinding = 0x445566n;

  const transferMemos: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`] = [
    encryptMemo(viewB.encPub,       { amount: SEND_AMOUNT,                        blinding: recipientBlinding, assetId: USDC_ID }, seedFrom(10n)),
    encryptMemo(viewA.encPub,       { amount: inNote0.amount - SEND_AMOUNT,       blinding: changeBlinding,    assetId: USDC_ID }, seedFrom(11n)),
    encryptMemo(viewRelayer.encPub, { amount: RELAYER_FEE,                        blinding: feeOutBlinding,    assetId: USDC_ID }, seedFrom(12n)),
    encryptMemo(viewA.encPub,       { amount: feeNote.amount - RELAYER_FEE,       blinding: feeChangeBlinding, assetId: USDC_ID }, seedFrom(13n)),
  ];

  const tResult = buildTransferInputs({
    sk:               SK_A,
    inNotes:          [inNote0],
    feeNote,
    tree:             syncResult1.tree,
    leafIndices:      [inNote0.leafIndex!, feeNote.leafIndex!],
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

  console.log("  proving transfer...");
  const tProof = await proveTransfer(tResult.inputs);
  console.log(`  proof=${tProof.proof.length}B`);

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
    chainId: Number(CHAIN_ID),
    pool:    POOL_ADDR,
  };

  const transferTxResult = await relayTransfer(RELAYER_URL, tRelayParams);
  console.log(`  transfer tx: ${txLink(transferTxResult.txHash)}`);
  assert(transferTxResult.status === "confirmed", "transfer confirmed");

  const transferReceipt = await pub.getTransactionReceipt({ hash: transferTxResult.txHash });
  console.log(`  gas=${transferReceipt.gasUsed}`);
  assert(
    transferReceipt.from.toLowerCase() === relayerAcc.address.toLowerCase(),
    "transfer: relayer is tx.from, not user A",
  );
  assert(
    transferReceipt.from.toLowerCase() !== userAAcc.address.toLowerCase(),
    "transfer: user A is NOT tx.from",
  );

  // ── 5. User B: recover + withdraw ─────────────────────────────────────────

  console.log("\n[5] User B recovers wallet and withdraws...");

  const syncResult2: SyncResult = await syncTree(asPCL(pub), poolContractLike, POOL_ADDR, DEPLOY_BLOCK);
  console.log(`  syncTree: ${syncResult2.leaves.length} leaves`);
  assert(syncResult2.leaves.length >= 7, "at least 7 leaves after transfer");

  const bStore = await recoverWallet(SK_B, { ownerKey: OK_B, encPriv: viewB.encPriv }, syncResult2, poolContractLike);
  const bNotes = bStore.unspent(USDC_ID);
  console.log(`  B found ${bNotes.length} note(s): ${bNotes.map(n => `${n.amount}@leaf${n.leafIndex}`).join(", ")}`);
  assert(bNotes.length === 1, "B has exactly 1 unspent note");
  assert(bNotes[0].amount === SEND_AMOUNT, `B note = ${SEND_AMOUNT}`);

  const bNote = bNotes[0];
  // Fresh withdraw address — never used before
  const WITHDRAW_ADDR = userBAcc.address;
  const WITHDRAW_AMOUNT = SEND_AMOUNT;
  const wChangeMemo = dummyMemo(seedFrom(21n));

  const wResult = buildWithdrawInputs({
    sk:             SK_B,
    note:           bNote,
    tree:           syncResult2.tree,
    leafIndex:      bNote.leafIndex!,
    recipient:      WITHDRAW_ADDR,
    amount:         WITHDRAW_AMOUNT,
    relayer:        relayerAcc.address,
    fee:            WITHDRAW_FEE,
    memos:          [wChangeMemo],
    pool:           POOL_ADDR,
    chainId:        CHAIN_ID,
    changeBlinding: 0n,
  });

  console.log("  proving withdraw...");
  const wProof = await proveWithdraw(wResult.inputs);
  console.log(`  proof=${wProof.proof.length}B`);

  const wRelayParams: WithdrawRelayParams = {
    proof:            `0x${Buffer.from(wProof.proof).toString("hex")}`,
    root:             toHex64(wResult.publicInputs[0]),
    nullifier:        toHex64(wResult.publicInputs[1]),
    recipient:        WITHDRAW_ADDR,
    amount:           WITHDRAW_AMOUNT.toString(),
    changeCommitment: toHex64(wResult.publicInputs[4]),
    relayer:          relayerAcc.address,
    fee:              WITHDRAW_FEE.toString(),
    memos:            [wChangeMemo],
    chainId:          Number(CHAIN_ID),
    pool:             POOL_ADDR,
  };

  const withdrawTxResult = await relayWithdraw(RELAYER_URL, wRelayParams);
  console.log(`  withdraw tx: ${txLink(withdrawTxResult.txHash)}`);
  assert(withdrawTxResult.status === "confirmed", "withdraw confirmed");

  const withdrawReceipt = await pub.getTransactionReceipt({ hash: withdrawTxResult.txHash });
  console.log(`  gas=${withdrawReceipt.gasUsed}`);
  assert(
    withdrawReceipt.from.toLowerCase() === relayerAcc.address.toLowerCase(),
    "withdraw: relayer is tx.from, not user B",
  );
  assert(
    withdrawReceipt.from.toLowerCase() !== userBAcc.address.toLowerCase(),
    "withdraw: user B is NOT tx.from",
  );

  // ── 6. Relayer recovers fee note ───────────────────────────────────────────

  console.log("\n[6] Relayer recovers fee note...");
  const syncResult3: SyncResult = await syncTree(asPCL(pub), poolContractLike, POOL_ADDR, DEPLOY_BLOCK);
  const rStore = await recoverWallet(SK_RELAYER, { ownerKey: relayerOwnerKey, encPriv: viewRelayer.encPriv }, syncResult3, poolContractLike);
  const rNotes = rStore.unspent(USDC_ID);
  console.log(`  relayer found ${rNotes.length} fee note(s)`);
  assert(rNotes.length >= 1, "relayer has at least 1 fee note");
  assert(rNotes[0].amount === RELAYER_FEE, `relayer fee = ${RELAYER_FEE}`);

  // ── 7. Balance assertions ──────────────────────────────────────────────────

  console.log("\n[7] Balance assertions...");
  const withdrawAddrBal = await pub.readContract({
    address: USDC_ADDR, abi: usdcAbi, functionName: "balanceOf", args: [WITHDRAW_ADDR],
  });
  console.log(`  withdraw addr (${WITHDRAW_ADDR}) USDC: ${withdrawAddrBal}`);
  // Contract sends (amount - fee) to recipient
  assert(
    (withdrawAddrBal) >= SEND_AMOUNT - WITHDRAW_FEE,
    `recipient received ${SEND_AMOUNT - WITHDRAW_FEE}`,
  );

  // ── 8. Negative tests ─────────────────────────────────────────────────────

  console.log("\n[8] Negative tests...");

  await expectReject(
    "short memo rejected",
    () => relayTransfer(RELAYER_URL, {
      ...tRelayParams,
      memos: ["0xaabbcc", ...tRelayParams.memos.slice(1)],
    }),
    400,
    "memo must be",
  );

  await expectReject(
    "wrong relayerOwnerKey rejected",
    () => relayTransfer(RELAYER_URL, {
      ...tRelayParams,
      args: { ...tRelayParams.args, relayerOwnerKey: toHex64(0xdeadbeefn) },
    }),
    400,
    "relayerOwnerKey mismatch",
  );

  await expectReject(
    "fee below minFee rejected",
    () => relayTransfer(RELAYER_URL, {
      ...tRelayParams,
      args: { ...tRelayParams.args, fee: toHex64(1n) },
    }),
    400,
    "fee too low",
  );

  await expectReject(
    "replayed proof rejected",
    () => relayTransfer(RELAYER_URL, tRelayParams),
    409,
    "nullifier already spent",
  );

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log("\n=== TESTNET E2E PASSED ===\n");
  console.log("Contracts:");
  console.log(`  PiiPool:          ${addrLink(deploy.contracts.PiiPool.address)}`);
  console.log(`  PiiKeyRegistry:   ${addrLink(deploy.contracts.PiiKeyRegistry.address)}`);
  console.log(`  WithdrawVerifier: ${addrLink(deploy.contracts.WithdrawVerifier.address)}`);
  console.log(`  TransferVerifier: ${addrLink(deploy.contracts.TransferVerifier.address)}`);

  console.log("\nTx hashes:");
  depositTxHashes.forEach((h, i) =>
    console.log(`  deposit[${i}]: ${txLink(h)}`));
  console.log(`  transfer:   ${txLink(transferTxResult.txHash)}  gas=${transferReceipt.gasUsed}`);
  console.log(`  withdraw:   ${txLink(withdrawTxResult.txHash)}  gas=${withdrawReceipt.gasUsed}`);
}

main()
  .catch(e => {
    console.error("\n[FAIL]", e);
    process.exit(1);
  })
  .finally(() => {
    relayerProc?.kill();
  });
