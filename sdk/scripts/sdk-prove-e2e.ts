/**
 * sdk/scripts/sdk-prove-e2e.ts
 *
 * Generates both E2E proofs using the SDK prover (noir_js + bb.js) with REAL
 * encrypted memos, then writes:
 *   contracts/test/fixtures/sdk_transfer_proof.bin
 *   contracts/test/fixtures/sdk_transfer_public_inputs.bin
 *   contracts/test/fixtures/sdk_withdraw_proof.bin
 *   contracts/test/fixtures/sdk_withdraw_public_inputs.bin
 *
 * Run: bun sdk/scripts/sdk-prove-e2e.ts
 *
 * Memo randomness is seeded from MEMO_SEED so fixtures are reproducible:
 *   MEMO_SEED=hex bun sdk/scripts/sdk-prove-e2e.ts
 *
 * Versions: @noir-lang/noir_js@1.0.0-rc.5  @aztec/bb.js@5.2.1
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash2 } from "../src/hash.js";
import { commitment } from "../src/note.js";
import type { Note } from "../src/note.js";
import { buildTree, EMPTY_TREE_ROOT } from "../src/tree.js";
import { buildTransferInputs, buildWithdrawInputs, extDataHash } from "../src/inputs.js";
import { proveTransfer, proveWithdraw } from "../src/prover.js";
import { deriveViewingKeys, encryptMemo, dummyMemo, MEMO_BYTE_LENGTH } from "../src/memo.js";

// ─── Per-memo testSeed helper ─────────────────────────────────────────────────
// Each memo gets a distinct 32-byte testSeed so BOTH ephPriv and nonce are
// fully reproducible.  The seed for memo i is all-0x(0x40+i) for readability.
// IMPORTANT: these testSeed values are for this script only — never use in production.

function memoSeed(idx: number): Uint8Array {
  return new Uint8Array(32).fill(0x40 + idx);
}

// ─── Scenario constants (mirror gen-e2e-fixture.ts) ─────────────────────────

const USDC_ID = 0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86en;

const SK_A = 7n;
const SK_B = 11n;
const SK_RELAYER = 13n;
const OK_A = hash2(SK_A, 0n);
const OK_B = hash2(SK_B, 0n);
const OK_RELAYER = hash2(SK_RELAYER, 0n);

const vkA = deriveViewingKeys(SK_A);
const vkB = deriveViewingKeys(SK_B);
const vkRelayer = deriveViewingKeys(SK_RELAYER);

const POOL = "0x0000000000000000000000000000000000001001" as `0x${string}`;
const RELAYER = "0x000000000000000000000000000000000000FEE0" as `0x${string}`;
const RECIPIENT_B = "0x000000000000000000000000000000000000bEEF" as `0x${string}`;
const CHAIN_ID = 31337n;

// ─── Notes ────────────────────────────────────────────────────────────────────

const noteA0: Note = { assetId: USDC_ID, amount: 2_000_000n, ownerKey: OK_A, blinding: 11n, leafIndex: 0 };
const noteA1: Note = { assetId: USDC_ID, amount: 1_000_000n, ownerKey: OK_A, blinding: 12n, leafIndex: 1 };
const noteFeeIn: Note = { assetId: USDC_ID, amount: 200_000n, ownerKey: OK_A, blinding: 13n, leafIndex: 2 };

const SEND = 2_500_000n;
const FEE = 50_000n;
const CHANGE = noteA0.amount + noteA1.amount - SEND; // 500_000

const noteRecipient: Note = { assetId: USDC_ID, amount: SEND, ownerKey: OK_B, blinding: 21n };
const noteChange: Note = { assetId: USDC_ID, amount: CHANGE, ownerKey: OK_A, blinding: 22n };
const noteFeeOut: Note = { assetId: USDC_ID, amount: FEE, ownerKey: OK_RELAYER, blinding: 24n };
// fee_change: feeIn.amount - fee = 200_000 - 50_000 = 150_000
const noteFeeChange: Note = { assetId: USDC_ID, amount: 150_000n, ownerKey: OK_A, blinding: 25n };

// Commitments for the 7-leaf tree (pre-transfer deposits + transfer outputs)
const CMT_A0  = commitment(noteA0);
const CMT_A1  = commitment(noteA1);
const CMT_FEE_IN = commitment(noteFeeIn);
const OUT_RECIP   = commitment(noteRecipient);
const OUT_CHANGE  = commitment(noteChange);
const OUT_FEE     = commitment(noteFeeOut);
const OUT_FEE_CHG = commitment(noteFeeChange);

// ─── Real memos (transfer: 4 outputs; withdraw: 1 output) ────────────────────
// Transfer output order per SPEC: [recipient, change→self, fee→relayer, fee_change→self]

// Each memo uses a distinct testSeed so BOTH ephPriv and nonce are deterministic.
const memoRecipient  = encryptMemo(vkB.encPub,        { assetId: USDC_ID, amount: SEND,      blinding: 21n }, memoSeed(0));
const memoChange     = encryptMemo(vkA.encPub,         { assetId: USDC_ID, amount: CHANGE,    blinding: 22n }, memoSeed(1));
const memoFee        = encryptMemo(vkRelayer.encPub,   { assetId: USDC_ID, amount: FEE,       blinding: 24n }, memoSeed(2));
const memoFeeChange  = encryptMemo(vkA.encPub,         { assetId: USDC_ID, amount: 150_000n,  blinding: 25n }, memoSeed(3));
const MEMOS_T: [`0x${string}`,`0x${string}`,`0x${string}`,`0x${string}`] =
  [memoRecipient, memoChange, memoFee, memoFeeChange];

// Withdraw has no change output (change == 0 → ZERO_VALUE sentinel); the change
// memo slot is a reproducible dummy encrypted to a throwaway key.
const MEMOS_W = [dummyMemo(memoSeed(4)) as `0x${string}`];

// ─── Log memo sizes ──────────────────────────────────────────────────────────

console.log("=== Pii SDK E2E Prover (with real memos) ===");
console.log(`noir_js: 1.0.0-rc.5  |  bb.js: 5.2.1`);
console.log(`Memo length: ${MEMO_BYTE_LENGTH}B (fixed)`);
console.log(`Transfer memos: ${MEMOS_T.map((m) => (m.length - 2) / 2 + "B").join(", ")}`);
console.log(`Withdraw memo:  ${(MEMOS_W[0].length - 2) / 2}B`);
console.log("");

// ─── Compute ext hashes (for updating SdkProof.t.sol) ────────────────────────

const extTransfer = extDataHash(MEMOS_T, RELAYER, FEE, "0x0000000000000000000000000000000000000000", CHAIN_ID, POOL);
const extWithdraw = extDataHash(MEMOS_W, "0x0000000000000000000000000000000000000000" as `0x${string}`, 0n, RECIPIENT_B, CHAIN_ID, POOL);
console.log(`EXT_TRANSFER = 0x${extTransfer.toString(16).padStart(64, "0")}`);
console.log(`EXT_WITHDRAW = 0x${extWithdraw.toString(16).padStart(64, "0")}`);
console.log("");

// ─── Trees ───────────────────────────────────────────────────────────────────

const tree3 = buildTree([CMT_A0, CMT_A1, CMT_FEE_IN]);
const tree7 = buildTree([CMT_A0, CMT_A1, CMT_FEE_IN, OUT_RECIP, OUT_CHANGE, OUT_FEE, OUT_FEE_CHG]);

// ─── Prove transfer ───────────────────────────────────────────────────────────

console.log("[transfer] building circuit inputs...");
const { inputs: transferInputs, publicInputs: transferPub } = buildTransferInputs({
  sk: SK_A,
  inNotes: [noteA0, noteA1],
  feeNote: noteFeeIn,
  feeSk: SK_A,
  tree: tree3,
  leafIndices: [0, 1, 2],
  recipientOwnerKey: OK_B,
  sendAmount: SEND,
  fee: FEE,
  relayerOwnerKey: OK_RELAYER,
  relayer: RELAYER,
  memos: MEMOS_T,
  pool: POOL,
  chainId: CHAIN_ID,
  blindings: {
    recipientBlinding: 21n,
    changeBlinding: 22n,
    feeOutBlinding: 24n,
    feeChangeBlinding: 25n,
  },
});

console.log(`[transfer] ext_data_hash in public inputs: 0x${transferPub[11].toString(16).padStart(64, "0")}`);

const t0Transfer = Date.now();
console.log("[transfer] proving (UltraHonk, verifierTarget: evm)...");
const transferResult = await proveTransfer(transferInputs);
const dtTransfer = Date.now() - t0Transfer;
console.log(`[transfer] DONE  proof=${transferResult.proof.length}B  time=${(dtTransfer / 1000).toFixed(1)}s`);

// ─── Prove withdraw ──────────────────────────────────────────────────────────

const noteB: Note = { assetId: USDC_ID, amount: SEND, ownerKey: OK_B, blinding: 21n, leafIndex: 3 };

console.log("[withdraw] building circuit inputs...");
const { inputs: withdrawInputs, publicInputs: withdrawPub } = buildWithdrawInputs({
  sk: SK_B,
  note: noteB,
  tree: tree7,
  leafIndex: 3,
  recipient: RECIPIENT_B,
  amount: SEND,
  relayer: "0x0000000000000000000000000000000000000000",
  fee: 0n,
  memos: MEMOS_W,
  pool: POOL,
  chainId: CHAIN_ID,
  changeBlinding: 0n,
});

console.log(`[withdraw] ext_data_hash in public inputs: 0x${withdrawPub[5].toString(16).padStart(64, "0")}`);

const t0Withdraw = Date.now();
console.log("[withdraw] proving...");
const withdrawResult = await proveWithdraw(withdrawInputs);
const dtWithdraw = Date.now() - t0Withdraw;
console.log(`[withdraw] DONE  proof=${withdrawResult.proof.length}B  time=${(dtWithdraw / 1000).toFixed(1)}s`);

// ─── Write fixtures ───────────────────────────────────────────────────────────

const FIXTURES = resolve(process.cwd(), "contracts/test/fixtures");

/** Convert an array of 0x-prefixed 32-byte hex strings to a flat byte buffer. */
function pubInputsToBytes(pubs: `0x${string}`[]): Uint8Array {
  const out = new Uint8Array(pubs.length * 32);
  for (let i = 0; i < pubs.length; i++) {
    const hex = pubs[i].replace("0x", "").padStart(64, "0");
    for (let j = 0; j < 32; j++) {
      out[i * 32 + j] = parseInt(hex.slice(j * 2, j * 2 + 2), 16);
    }
  }
  return out;
}

// proof is now raw bytes (no public inputs prepended); public inputs are separate.
writeFileSync(resolve(FIXTURES, "sdk_transfer_proof.bin"), transferResult.proof);
const tPub = pubInputsToBytes(transferResult.publicInputs);
writeFileSync(resolve(FIXTURES, "sdk_transfer_public_inputs.bin"), tPub);
console.log(`Wrote sdk_transfer_proof.bin (${transferResult.proof.length}B) + sdk_transfer_public_inputs.bin (${tPub.length}B)`);

const wPub = pubInputsToBytes(withdrawResult.publicInputs);
writeFileSync(resolve(FIXTURES, "sdk_withdraw_proof.bin"), withdrawResult.proof);
writeFileSync(resolve(FIXTURES, "sdk_withdraw_public_inputs.bin"), wPub);
console.log(`Wrote sdk_withdraw_proof.bin (${withdrawResult.proof.length}B) + sdk_withdraw_public_inputs.bin (${wPub.length}B)`);

// ─── Print constants for SdkProof.t.sol ──────────────────────────────────────

console.log("");
console.log("=== SdkProof.t.sol constants to update ===");
console.log(`EXT_TRANSFER = 0x${transferPub[11].toString(16).padStart(64, "0")};`);
console.log(`EXT_WITHDRAW = 0x${withdrawPub[5].toString(16).padStart(64, "0")};`);
console.log("");
console.log("Transfer memos (for _transferMemos()):");
MEMOS_T.forEach((m, i) => console.log(`  m[${i}] = hex"${m.slice(2)}";`));
console.log("Withdraw memo (for _withdrawMemos()):");
console.log(`  m[0] = hex"${MEMOS_W[0].slice(2)}";`);

console.log("");
console.log("=== Summary ===");
console.log(`Transfer: ${(dtTransfer / 1000).toFixed(1)}s  proof=${tProof.length}B  pubInputs=${tPub.length}B`);
console.log(`Withdraw: ${(dtWithdraw / 1000).toFixed(1)}s  proof=${wProof.length}B  pubInputs=${wPub.length}B`);
