/**
 * sdk/src/inputs.ts
 *
 * Pure functions that map SDK objects → circuit ABI inputs.
 * Never reads from TOML; always computes values from first principles.
 */

import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import { hash2, hash3, ZERO_VALUE, BN254_R } from "./hash.js";
import { EMPTY_TREE_ROOT } from "./tree.js";
import { MerkleTree } from "./tree.js";
import { Note, commitment as noteCommitment, nullifier as noteNullifier, depositSecret } from "./note.js";

/**
 * Computes note_commitment as the circuit does for *input* notes:
 *   hash3(assetId, amount, depositSecret(ownerKey, blinding))
 * without the SDK's ZERO_VALUE shortcut (which is for *output* slots only).
 * Used when computing nullifiers for phantom (amount=0) input notes.
 */
function inputNoteCommitment(note: Pick<Note, "assetId" | "amount" | "ownerKey" | "blinding">): bigint {
  const secret = depositSecret(note.ownerKey, note.blinding);
  return hash3(note.assetId, note.amount, secret);
}

/** Nullifier for an input note: hash2(inputNoteCommitment, sk). Matches the circuit for all amounts. */
function inputNoteNullifier(note: Pick<Note, "assetId" | "amount" | "ownerKey" | "blinding">, sk: bigint): bigint {
  return hash2(inputNoteCommitment(note), sk);
}

// ─── Types ─────────────────────────────────────────────────────────────────

/** Witness inputs for the withdraw circuit (matches Noir ABI parameter names). */
export type WithdrawCircuitInputs = {
  // Public
  merkle_root: string;
  nullifier: string;
  recipient: string;
  amount: string;
  change_commitment: string;
  ext_data_hash: string;
  // Private
  spending_key: string;
  note_amount: string;
  note_blinding: string;
  merkle_siblings: string[];
  merkle_bits: string[];
  change_blinding: string;
};

/** Witness inputs for the transfer circuit (matches Noir ABI parameter names). */
export type TransferCircuitInputs = {
  // Public
  merkle_root: string;
  nf_0: string;
  nf_1: string;
  nf_fee: string;
  out_recipient: string;
  out_change: string;
  out_fee: string;
  out_fee_change: string;
  eligibility_root: string;
  fee: string;
  relayer_owner_key: string;
  ext_data_hash: string;
  // Private
  asset: string;
  in_amount: string[];
  in_sk: string[];
  in_blinding: string[];
  in_siblings_0: string[];
  in_bits_0: string[];
  in_siblings_1: string[];
  in_bits_1: string[];
  fee_amount_in: string;
  fee_sk: string;
  fee_blinding_in: string;
  fee_siblings: string[];
  fee_bits: string[];
  send_amount: string;
  recipient_owner: string;
  recipient_blinding: string;
  change_blinding: string;
  fee_out_blinding: string;
  fee_change_blinding: string;
  elig_siblings: string[];
  elig_bits: string[];
};

export type WithdrawBuildResult = {
  inputs: WithdrawCircuitInputs;
  publicInputs: bigint[];
};

export type TransferBuildResult = {
  inputs: TransferCircuitInputs;
  publicInputs: bigint[];
};

// ─── ext_data_hash ─────────────────────────────────────────────────────────

/**
 * Compute ext_data_hash exactly as PiiPool does on-chain:
 *   keccak256(abi.encode(memos, relayer, fee, recipient, chainId, pool)) mod r
 *
 * @param memos     Array of arbitrary-length bytes (as 0x-prefixed hex strings)
 * @param relayer   20-byte address (0x-prefixed hex)
 * @param fee       Fee amount
 * @param recipient 20-byte address (use address(0) for shielded transfers)
 * @param chainId   Chain ID
 * @param pool      Pool contract address
 */
export function extDataHash(
  memos: `0x${string}`[],
  relayer: `0x${string}`,
  fee: bigint,
  recipient: `0x${string}`,
  chainId: bigint,
  pool: `0x${string}`,
): bigint {
  const encoded = encodeAbiParameters(
    parseAbiParameters("bytes[], address, uint256, address, uint256, address"),
    [memos, relayer, fee, recipient, chainId, pool],
  );
  const h = keccak256(encoded);
  return BigInt(h) % BN254_R;
}

// ─── toField helpers ────────────────────────────────────────────────────────

function toHex(v: bigint): string {
  return "0x" + v.toString(16).padStart(64, "0");
}

function zeroPathBig(): { siblings: bigint[]; bits: bigint[] } {
  const z: bigint[] = Array(20).fill(0n);
  return { siblings: z.slice(), bits: z.slice() };
}

// ─── buildWithdrawInputs ───────────────────────────────────────────────────

export type WithdrawParams = {
  sk: bigint;
  note: Note;
  tree: MerkleTree;
  leafIndex: number;
  recipient: `0x${string}`;
  amount: bigint;
  relayer: `0x${string}`;
  fee: bigint;
  memos: `0x${string}`[];
  pool: `0x${string}`;
  chainId: bigint;
  changeBlinding: bigint;
};

export function buildWithdrawInputs(p: WithdrawParams): WithdrawBuildResult {
  if (p.amount > p.note.amount) throw new Error("withdraw amount > note amount");
  // The circuit only sees `amount` and `change = note_amount - amount`.
  // The relayer fee is deducted by the pool contract out of `amount` — it is NOT
  // subtracted inside the circuit.  Callers must ensure fee <= amount.
  if (p.fee > p.amount) throw new Error("fee > amount");

  const net = p.amount; // full withdrawal amount that the pool receives from the note
  const change = p.note.amount - net; // always >= 0; fee comes out of net at the contract level

  // change_commitment = ZERO_VALUE when change == 0
  const changeCmt =
    change === 0n ? ZERO_VALUE : noteCommitment({ assetId: p.note.assetId, amount: change, ownerKey: p.note.ownerKey, blinding: p.changeBlinding });

  const path = p.tree.authPath(p.leafIndex);
  if (!path) throw new Error(`leafIndex ${p.leafIndex} not in tree`);

  const nf = inputNoteNullifier(p.note, p.sk);

  const edh = extDataHash(
    p.memos,
    p.relayer,
    p.fee,
    p.recipient,
    p.chainId,
    p.pool,
  );

  const recipientField = BigInt(p.recipient);

  const inputs: WithdrawCircuitInputs = {
    merkle_root: toHex(p.tree.root),
    nullifier: toHex(nf),
    recipient: toHex(recipientField),
    amount: toHex(net),
    change_commitment: toHex(changeCmt),
    ext_data_hash: toHex(edh),
    spending_key: toHex(p.sk),
    note_amount: toHex(p.note.amount),
    note_blinding: toHex(p.note.blinding),
    merkle_siblings: path.siblings.map(toHex),
    merkle_bits: path.bits.map(toHex),
    change_blinding: toHex(p.changeBlinding),
  };

  const publicInputs: bigint[] = [
    p.tree.root,
    nf,
    recipientField,
    net,
    changeCmt,
    edh,
  ];

  return { inputs, publicInputs };
}

// ─── buildTransferInputs ───────────────────────────────────────────────────

export type TransferParams = {
  sk: bigint;
  inNotes: [Note] | [Note, Note]; // 1 or 2 input notes, same owner
  feeNote?: Note; // optional separate fee input note (same owner)
  feeSk?: bigint; // spending key for feeNote (if different from sk)
  tree: MerkleTree;
  leafIndices: number[]; // [in0, in1?, fee?]
  recipientOwnerKey: bigint;
  sendAmount: bigint;
  fee: bigint;
  relayerOwnerKey: bigint;
  relayer: `0x${string}`;
  memos: [
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
  ]; // exactly 4
  pool: `0x${string}`;
  chainId: bigint;
  blindings: {
    recipientBlinding: bigint;
    changeBlinding: bigint;
    feeOutBlinding: bigint;
    feeChangeBlinding: bigint;
    phantomBlinding?: bigint; // for phantom in[1]
    feeInBlinding?: bigint; // for phantom fee_in
  };
};

/** Zero-padded path of depth-20 zeros used for phantom inputs. */
function phantomPath(): { siblings: bigint[]; bits: bigint[] } {
  return zeroPathBig();
}

export function buildTransferInputs(p: TransferParams): TransferBuildResult {
  const { sk, inNotes, feeNote, tree, leafIndices } = p;
  const feeSk = p.feeSk ?? sk;

  // ── note 0 (always real) ──
  const note0 = inNotes[0];
  const path0 = tree.authPath(leafIndices[0]);
  if (!path0) throw new Error(`leafIndex[0] ${leafIndices[0]} not in tree`);
  // Use inputNoteNullifier (matches circuit: no ZERO_VALUE shortcut for amount=0)
  const nf0 = inputNoteNullifier(note0, sk);

  // ── note 1 (may be phantom) ──
  const note1Real = inNotes[1] as Note | undefined;
  const phantomBlinding = p.blindings.phantomBlinding ?? 42n;
  const note1: Note = note1Real ?? {
    assetId: note0.assetId,
    amount: 0n,
    ownerKey: note0.ownerKey,
    blinding: phantomBlinding,
  };
  const path1Real = note1Real ? tree.authPath(leafIndices[1]) : null;
  if (note1Real && !path1Real) throw new Error(`leafIndex[1] ${leafIndices[1]} not in tree`);
  const path1 = path1Real ?? phantomPath();
  const nf1 = inputNoteNullifier(note1Real ?? note1, sk);

  // ── fee input (may be phantom) ──
  const feeInBlinding = p.blindings.feeInBlinding ?? 99n;
  const feeNoteActual: Note = feeNote ?? {
    assetId: note0.assetId,
    amount: 0n,
    ownerKey: note0.ownerKey,
    blinding: feeInBlinding,
  };
  const feePathReal = feeNote ? tree.authPath(leafIndices[inNotes.length]) : null;
  if (feeNote && !feePathReal) throw new Error(`fee leafIndex not in tree`);
  const feePath = feePathReal ?? phantomPath();
  const nfFee = inputNoteNullifier(feeNoteActual, feeSk);

  // ── outputs ──
  const totalIn = note0.amount + note1.amount + feeNoteActual.amount;
  const change = note0.amount + note1.amount - p.sendAmount;
  // fee change = feeNote.amount - fee (when feeNote is real), else 0
  const feeChange = feeNote ? feeNoteActual.amount - p.fee : 0n;

  if (change < 0n) throw new Error("insufficient input for send");
  if (feeChange < 0n) throw new Error("insufficient fee input");

  const outRecipient = noteCommitment({
    assetId: note0.assetId,
    amount: p.sendAmount,
    ownerKey: p.recipientOwnerKey,
    blinding: p.blindings.recipientBlinding,
  });
  const outChange =
    change === 0n
      ? ZERO_VALUE
      : noteCommitment({
          assetId: note0.assetId,
          amount: change,
          ownerKey: note0.ownerKey,
          blinding: p.blindings.changeBlinding,
        });
  const outFee =
    p.fee === 0n
      ? ZERO_VALUE
      : noteCommitment({
          assetId: note0.assetId,
          amount: p.fee,
          ownerKey: p.relayerOwnerKey,
          blinding: p.blindings.feeOutBlinding,
        });
  const outFeeChange =
    feeChange === 0n
      ? ZERO_VALUE
      : noteCommitment({
          assetId: note0.assetId,
          amount: feeChange,
          ownerKey: note0.ownerKey,
          blinding: p.blindings.feeChangeBlinding,
        });

  // ── eligibility (always EMPTY_TREE_ROOT for USDC in v1) ──
  const eligRoot = EMPTY_TREE_ROOT;
  const eligPath = phantomPath();

  // ── ext_data_hash ──
  const edh = extDataHash(
    p.memos,
    p.relayer,
    p.fee,
    // recipient field for transfer is address(0) (shielded owner_key, not address)
    "0x0000000000000000000000000000000000000000",
    p.chainId,
    p.pool,
  );

  const inputs: TransferCircuitInputs = {
    // Public
    merkle_root: toHex(tree.root),
    nf_0: toHex(nf0),
    nf_1: toHex(nf1),
    nf_fee: toHex(nfFee),
    out_recipient: toHex(outRecipient),
    out_change: toHex(outChange),
    out_fee: toHex(outFee),
    out_fee_change: toHex(outFeeChange),
    eligibility_root: toHex(eligRoot),
    fee: toHex(p.fee),
    relayer_owner_key: toHex(p.relayerOwnerKey),
    ext_data_hash: toHex(edh),
    // Private
    asset: toHex(note0.assetId),
    in_amount: [toHex(note0.amount), toHex(note1.amount)],
    in_sk: [toHex(sk), toHex(sk)],
    in_blinding: [toHex(note0.blinding), toHex(note1.blinding)],
    in_siblings_0: path0.siblings.map(toHex),
    in_bits_0: path0.bits.map(toHex),
    in_siblings_1: path1.siblings.map(toHex),
    in_bits_1: path1.bits.map(toHex),
    fee_amount_in: toHex(feeNoteActual.amount),
    fee_sk: toHex(feeSk),
    fee_blinding_in: toHex(feeNoteActual.blinding),
    fee_siblings: feePath.siblings.map(toHex),
    fee_bits: feePath.bits.map(toHex),
    send_amount: toHex(p.sendAmount),
    recipient_owner: toHex(p.recipientOwnerKey),
    recipient_blinding: toHex(p.blindings.recipientBlinding),
    change_blinding: toHex(p.blindings.changeBlinding),
    fee_out_blinding: toHex(p.blindings.feeOutBlinding),
    fee_change_blinding: toHex(p.blindings.feeChangeBlinding),
    elig_siblings: eligPath.siblings.map(toHex),
    elig_bits: eligPath.bits.map(toHex),
  };

  const publicInputs: bigint[] = [
    tree.root,
    nf0,
    nf1,
    nfFee,
    outRecipient,
    outChange,
    outFee,
    outFeeChange,
    eligRoot,
    p.fee,
    p.relayerOwnerKey,
    edh,
  ];

  return { inputs, publicInputs };
}
