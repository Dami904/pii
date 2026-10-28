/**
 * gen-e2e-fixture.ts
 * Generates Prover.e2e.toml for circuits/transfer and circuits/withdraw.
 *
 * Scenario:
 *   Three deposits into the pool (leaves 0, 1, 2):
 *     leaf 0: A sk=7, blinding=11, amount=2_000_000 USDC
 *     leaf 1: A sk=7, blinding=12, amount=1_000_000 USDC
 *     leaf 2: fee note sk=7, blinding=13, amount=200_000 USDC
 *
 *   Transfer (USDC, asset = USDC_ID):
 *     in[0]=leaf0 (2_000_000), in[1]=leaf1 (1_000_000), fee_in=leaf2 (200_000)
 *     send 2_500_000 to B (owner_key(11), blinding=21)   → leaf 3
 *     change 500_000 to A (owner_key(7), blinding=22)    → leaf 4
 *     fee 50_000 to relayer_owner_key(13)                → leaf 5
 *     fee_change 150_000 to A (owner_key(7), blinding=23)→ leaf 6
 *     relayer = 0x...fEE0, eligibility_root = empty_root (USDC transfer, no check)
 *     memos = 4 distinct short bytes values
 *
 *   B's withdraw (leaf 3, post-transfer root):
 *     withdraw 2_500_000 to 0x...bEEF, no fee, no change
 *
 * Output: circuits/transfer/Prover.e2e.toml, circuits/withdraw/Prover.e2e.toml
 *
 * Run: bun sdk/scripts/gen-e2e-fixture.ts
 */

import { poseidon2Hash } from "@zkpassport/poseidon2";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import { writeFileSync } from "fs";
import { join } from "path";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BN254_R = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);
const ZERO_VALUE = BigInt(
  "0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466"
);
const USDC_ADDRESS = BigInt("0x3600000000000000000000000000000000000000");
const POOL = "0x0000000000000000000000000000000000001001";
const CHAIN_ID = 31337n;
const RECIPIENT_B = "0x000000000000000000000000000000000000bEEF";
const RELAYER    = "0x000000000000000000000000000000000000FEE0";

function hash2(a: bigint, b: bigint): bigint { return poseidon2Hash([a, b]); }
function hash3(a: bigint, b: bigint, c: bigint): bigint { return poseidon2Hash([a, b, c]); }
function hash8(a: bigint[]): bigint { return poseidon2Hash(a); }

function toHex(v: bigint, pad = 64): string {
  return "0x" + v.toString(16).padStart(pad, "0");
}

function toField(v: bigint): string { return toHex(v); }

function usdc_asset_id(): bigint { return hash2(USDC_ADDRESS, 0n); }
function owner_key(sk: bigint): bigint { return hash2(sk, 0n); }
function note_secret(ok: bigint, blinding: bigint): bigint { return hash2(ok, blinding); }
function note_commitment(asset_id: bigint, amount: bigint, secret: bigint): bigint {
  return hash3(asset_id, amount, secret);
}
function nullifier(cmt: bigint, sk: bigint): bigint { return hash2(cmt, sk); }
function output_commitment(asset_id: bigint, amount: bigint, ok: bigint, blinding: bigint): bigint {
  if (amount === 0n) return ZERO_VALUE;
  return note_commitment(asset_id, amount, hash2(ok, blinding));
}

// ── Merkle tree (mirrors PiiMerkle._insert) ───────────────────────────────────

const DEPTH = 20;

function compute_zeros(): bigint[] {
  const z: bigint[] = new Array(DEPTH + 1);
  z[0] = ZERO_VALUE;
  for (let i = 1; i <= DEPTH; i++) z[i] = hash2(z[i-1], z[i-1]);
  return z;
}

// Insert leaves sequentially; return paths for each leaf at insertion time
// AND the final root after all insertions.
function build_incremental_tree(leaves: bigint[]): {
  paths: Array<{ siblings: bigint[]; bits: bigint[]; root: bigint }>;
  finalRoot: bigint;
} {
  const zeros = compute_zeros();
  const filled: bigint[] = zeros.slice();
  const paths: Array<{ siblings: bigint[]; bits: bigint[]; root: bigint }> = [];

  for (let idx = 0; idx < leaves.length; idx++) {
    const leaf = leaves[idx];
    const siblings: bigint[] = new Array(DEPTH);
    const bits: bigint[] = new Array(DEPTH);
    let cur = leaf;
    for (let i = 0; i < DEPTH; i++) {
      const bit = (idx >> i) & 1;
      bits[i] = BigInt(bit);
      if (bit === 0) {
        siblings[i] = zeros[i];
        zeros[i] = cur;  // update zeros to track the rightmost filled node
      } else {
        siblings[i] = filled[i];
        cur = hash2(filled[i], cur);
        // When we go right, the left is filled[i], update:
        filled[i] = zeros[i]; // not quite right — use proper filled tracking
        break; // the tree algorithm stops early on a right turn... wait, no
      }
    }
    // Re-implement correctly using the proper incremental algorithm:
    // We need to track 'filled' properly.
    paths.push({ siblings, bits, root: 0n }); // placeholder
  }

  // Re-implement from scratch correctly:
  return buildCorrect(leaves);
}

function buildCorrect(leaves: bigint[]): {
  paths: Array<{ siblings: bigint[]; bits: bigint[]; root: bigint }>;
  finalRoot: bigint;
} {
  const zeros = compute_zeros();
  // filled[i] = the current "left node" at level i (starts as zeros[i])
  const filled: bigint[] = zeros.slice();
  const paths: Array<{ siblings: bigint[]; bits: bigint[]; root: bigint }> = [];
  let lastRoot = zeros[DEPTH];

  for (let idx = 0; idx < leaves.length; idx++) {
    const siblings: bigint[] = new Array(DEPTH).fill(0n);
    const bits: bigint[] = new Array(DEPTH).fill(0n);
    let cur = leaves[idx];

    for (let i = 0; i < DEPTH; i++) {
      const bit = (idx >> i) & 1;
      bits[i] = BigInt(bit);
      if (bit === 0) {
        // we are the left child; sibling = zeros[i] (the right placeholder)
        siblings[i] = zeros[i];
        filled[i] = cur;  // record this as the filled left node
        cur = hash2(cur, zeros[i]);
      } else {
        // we are the right child; sibling = filled[i] (the previous left)
        siblings[i] = filled[i];
        cur = hash2(filled[i], cur);
        // filled[i] stays as-is for next iteration at this level
      }
    }
    lastRoot = cur;
    paths.push({ siblings, bits, root: cur });
  }

  return { paths, finalRoot: lastRoot };
}

// Compute the root of a tree after ALL given leaves are inserted,
// using each leaf's FINAL path against the final root.
// For the withdraw (after transfer), we need the path for leaf@3 against root after 7 leaves.
function buildAllPaths(leaves: bigint[]): {
  paths: Array<{ siblings: bigint[]; bits: bigint[]; root: bigint }>;
  finalRoot: bigint;
} {
  return buildCorrect(leaves);
}

// ── ext_data_hash helper ──────────────────────────────────────────────────────

function extDataHash(
  memos: `0x${string}`[],
  relayer: string,
  fee: bigint,
  recipient: string,
  chainId: bigint,
  pool: string
): bigint {
  const encoded = encodeAbiParameters(
    parseAbiParameters("bytes[], address, uint256, address, uint256, address"),
    [memos, relayer as `0x${string}`, fee, recipient as `0x${string}`, chainId, pool as `0x${string}`]
  );
  return BigInt(keccak256(encoded)) % BN254_R;
}

// ── Order commitment (SPEC §2) ────────────────────────────────────────────────

function order_commitment(
  side: bigint, price: bigint, amount: bigint,
  asset_base: bigint, asset_quote: bigint,
  ok: bigint, nonce: bigint, expiry: bigint
): bigint {
  return hash8([side, price, amount, asset_base, asset_quote, ok, nonce, expiry]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const zeros = compute_zeros();
const USDC_ID = usdc_asset_id();
const EMPTY_ROOT = zeros[DEPTH];

// Owner keys
const okA = owner_key(7n);   // sk=7
const okB = owner_key(11n);  // sk=11 (B's spending_key)
const okFee = owner_key(7n); // fee note also owned by A (sk=7) for simplicity

// Input notes (pre-deposit)
const secA0  = note_secret(okA, 11n);   // blinding=11
const secA1  = note_secret(okA, 12n);   // blinding=12
const secFee = note_secret(okA, 13n);   // blinding=13

const cmtA0  = note_commitment(USDC_ID, 2_000_000n, secA0);
const cmtA1  = note_commitment(USDC_ID, 1_000_000n, secA1);
const cmtFee = note_commitment(USDC_ID,   200_000n, secFee);

// Build tree with these 3 leaves (deposit order: 0, 1, 2)
const depositLeaves = [cmtA0, cmtA1, cmtFee];
const { paths: depositPaths, finalRoot: root3 } = buildCorrect(depositLeaves);

// Paths at insertion time (these are the paths against the root at insertion time)
// But the circuit uses ONE merkle_root for all 3 inputs. We need paths against root3.
// Rebuild paths for each leaf against root3 (the final 3-leaf root):

// For 3 leaves at positions 0, 1, 2 in the final tree, compute auth paths against root3.
// Position 0 (bits 00..0): sib[0]=cmtA1, sib[1]=hash2(cmtFee,zeros[0]), sib[2..]=zeros[2..]
// Position 1 (bits 10..0): sib[0]=cmtA0, sib[1]=hash2(cmtFee,zeros[0]), sib[2..]=zeros[2..]
// Position 2 (bits 01..0): sib[0]=zeros[0], sib[1]=hash2(cmtA0,cmtA1), sib[2..]=zeros[2..]

function pathAgainstFinalRoot(
  leaves: bigint[],
  targetIdx: number
): { siblings: bigint[]; bits: bigint[]; root: bigint } {
  // Build all pairwise nodes for a complete binary tree with these leaves + zeros fill.
  // Level 0: leaves themselves
  // Level i: hash pairs from level i-1
  const n = leaves.length;
  // Use a flat representation
  const nodes: bigint[][] = new Array(DEPTH + 1);
  nodes[0] = new Array(1 << DEPTH).fill(ZERO_VALUE);
  for (let i = 0; i < n; i++) nodes[0][i] = leaves[i];
  for (let lev = 1; lev <= DEPTH; lev++) {
    const width = 1 << (DEPTH - lev);
    nodes[lev] = new Array(width);
    for (let i = 0; i < width; i++) {
      nodes[lev][i] = hash2(nodes[lev-1][2*i], nodes[lev-1][2*i+1]);
    }
  }
  const root = nodes[DEPTH][0];
  const siblings: bigint[] = new Array(DEPTH);
  const bits: bigint[] = new Array(DEPTH);
  let pos = targetIdx;
  for (let i = 0; i < DEPTH; i++) {
    const bit = pos & 1;
    bits[i] = BigInt(bit);
    siblings[i] = bit === 0 ? nodes[i][pos + 1] : nodes[i][pos - 1];
    pos >>= 1;
  }
  return { siblings, bits, root };
}

// This flat approach is expensive for DEPTH=20 (2^20 leaves) but correct.
// Instead use the efficient approach that computes only the needed siblings:

function pathAgainstRoot3Efficient(
  cmtA0: bigint, cmtA1: bigint, cmtFee: bigint,
  targetIdx: number
): { siblings: bigint[]; bits: bigint[]; root: bigint } {
  const z = zeros;
  // Level 0: [cmt0, cmt1, cmt2, z[0], z[0], ...]
  // Level 1: [hash(cmt0,cmt1), hash(cmt2,z[0]), hash(z[0],z[0])=z[1], ...]
  //         = [p01, p2z, z[1], ...]
  // Level 2: [hash(p01,p2z), hash(z[1],z[1])=z[2], ...]
  //         = [p0123, z[2], ...]
  // Level 3+: [hash(p0123,z[2]), ...] = [root, ...]
  const p01 = hash2(cmtA0, cmtA1);
  const p2z = hash2(cmtFee, z[0]);
  const p0123 = hash2(p01, p2z);
  let root = p0123;
  for (let i = 2; i < DEPTH; i++) root = hash2(root, z[i]);

  const siblings: bigint[] = new Array(DEPTH).fill(0n);
  const bits: bigint[] = new Array(DEPTH).fill(0n);

  if (targetIdx === 0) {
    // pos 0: bits=[0,0,0,...], sibs=[cmt1, p2z, z[2], ...]
    bits[0] = 0n; siblings[0] = cmtA1;
    bits[1] = 0n; siblings[1] = p2z;
    for (let i = 2; i < DEPTH; i++) { bits[i] = 0n; siblings[i] = z[i]; }
  } else if (targetIdx === 1) {
    // pos 1: bits=[1,0,0,...], sibs=[cmt0, p2z, z[2], ...]
    bits[0] = 1n; siblings[0] = cmtA0;
    bits[1] = 0n; siblings[1] = p2z;
    for (let i = 2; i < DEPTH; i++) { bits[i] = 0n; siblings[i] = z[i]; }
  } else { // targetIdx === 2
    // pos 2: bits=[0,1,0,...], sibs=[z[0], p01, z[2], ...]
    bits[0] = 0n; siblings[0] = z[0];
    bits[1] = 1n; siblings[1] = p01;
    for (let i = 2; i < DEPTH; i++) { bits[i] = 0n; siblings[i] = z[i]; }
  }
  return { siblings, bits, root };
}

const path0 = pathAgainstRoot3Efficient(cmtA0, cmtA1, cmtFee, 0);
const path1 = pathAgainstRoot3Efficient(cmtA0, cmtA1, cmtFee, 1);
const path2 = pathAgainstRoot3Efficient(cmtA0, cmtA1, cmtFee, 2);

console.log("root3 from buildCorrect:", toHex(root3));
console.log("root3 from pathAgainst:  ", toHex(path0.root));
// These should match if algorithm is consistent

// Use path0.root as the canonical root3 (both methods agree if correct)
const MERKLE_ROOT_3 = path0.root;

// ── Nullifiers ────────────────────────────────────────────────────────────────

const nf0   = nullifier(cmtA0,  7n);  // sk=7 for in[0]
const nf1   = nullifier(cmtA1,  7n);  // sk=7 for in[1]
const nfFee = nullifier(cmtFee, 7n);  // sk=7 for fee_in

// ── Output notes ──────────────────────────────────────────────────────────────

const okRecip = owner_key(11n);  // B's owner_key (sk=11)
const okRelayer = owner_key(13n); // relayer's owner_key (sk=13)

const outRecipBlinding   = 21n;
const outChangeBlinding  = 22n;
const outFeeBlinding     = 24n;
const outFeeChgBlinding  = 25n;

const outRecipSec  = note_secret(okRecip,   outRecipBlinding);
const outChangeSec = note_secret(okA,       outChangeBlinding);
const outFeeSec    = note_secret(okRelayer, outFeeBlinding);
const outFeeChgSec = note_secret(okA,       outFeeChgBlinding);

const SEND_AMOUNT    = 2_500_000n;
const CHANGE_AMOUNT  =   500_000n;
const FEE_AMOUNT     =    50_000n;
const FEE_CHG_AMOUNT =   150_000n;

// verify: in0+in1 = send+change
console.assert(2_000_000n + 1_000_000n === SEND_AMOUNT + CHANGE_AMOUNT, "sum check");
// verify: fee_in = fee+fee_change
console.assert(200_000n === FEE_AMOUNT + FEE_CHG_AMOUNT, "fee sum check");

const outRecipCmt  = note_commitment(USDC_ID, SEND_AMOUNT,    outRecipSec);
const outChangeCmt = note_commitment(USDC_ID, CHANGE_AMOUNT,  outChangeSec);
const outFeeCmt    = note_commitment(USDC_ID, FEE_AMOUNT,     outFeeSec);
const outFeeChgCmt = note_commitment(USDC_ID, FEE_CHG_AMOUNT, outFeeChgSec);

// ── Eligibility tree (empty root for USDC transfer) ──────────────────────────

const ELIG_ROOT = EMPTY_ROOT;

// Eligibility path: phantoms (in a USDC transfer, eligibility check is skipped in-circuit
// when asset == USDC. But we still need valid path values — use a trivial 1-leaf tree
// of eligibility_leaf(usdc_id, okRecip)):
const eligLeaf = hash2(USDC_ID, okRecip);
const eligPath = buildCorrect([eligLeaf]);
// Actually for USDC transfer, the circuit skips the membership check (send==0 OR asset==USDC_ID).
// We pass the empty root and zeros siblings.
const eligSiblings = new Array(DEPTH).fill(0n).map((_, i) => zeros[i]);
const eligBits     = new Array(DEPTH).fill(0n);

// ── Transfer memos ────────────────────────────────────────────────────────────

const MEMOS: `0x${string}`[] = ["0xaa01", "0xaa02", "0xaa03", "0xaa04"];

// ── ext_data_hash for transfer ────────────────────────────────────────────────
// recipient = address(0) for transfer

const EXT_TRANSFER = extDataHash(MEMOS, RELAYER, FEE_AMOUNT, "0x0000000000000000000000000000000000000000", CHAIN_ID, POOL);

// ── Build transfer Prover.e2e.toml ────────────────────────────────────────────

function arr(v: bigint[]): string {
  return "[" + v.map(x => `"${toField(x)}"`).join(", ") + "]";
}

function tomlTransfer(): string {
  // in_siblings and in_bits are declared as flat params in the circuit:
  //   in_siblings_0, in_bits_0 (for input note 0)
  //   in_siblings_1, in_bits_1 (for input note 1)
  // They must NOT be nested TOML arrays.
  return `# Pii E2E transfer fixture — gen-e2e-fixture.ts
# in0=2M, in1=1M, fee_in=200k; send 2.5M to B, change 500k to A, fee 50k, fee_change 150k

# Public inputs (SPEC §4.2 order)
merkle_root      = "${toField(MERKLE_ROOT_3)}"
nf_0             = "${toField(nf0)}"
nf_1             = "${toField(nf1)}"
nf_fee           = "${toField(nfFee)}"
out_recipient    = "${toField(outRecipCmt)}"
out_change       = "${toField(outChangeCmt)}"
out_fee          = "${toField(outFeeCmt)}"
out_fee_change   = "${toField(outFeeChgCmt)}"
eligibility_root = "${toField(ELIG_ROOT)}"
fee              = "${toField(FEE_AMOUNT)}"
relayer_owner_key = "${toField(okRelayer)}"
ext_data_hash    = "${toField(EXT_TRANSFER)}"

# Private inputs
asset          = "${toField(USDC_ID)}"
in_amount      = ["${toField(2_000_000n)}", "${toField(1_000_000n)}"]
in_sk          = ["${toField(7n)}", "${toField(7n)}"]
in_blinding    = ["${toField(11n)}", "${toField(12n)}"]
in_siblings_0 = ${arr(path0.siblings)}
in_bits_0     = ${arr(path0.bits)}
in_siblings_1 = ${arr(path1.siblings)}
in_bits_1     = ${arr(path1.bits)}
fee_amount_in  = "${toField(200_000n)}"
fee_sk         = "${toField(7n)}"
fee_blinding_in = "${toField(13n)}"
fee_siblings   = ${arr(path2.siblings)}
fee_bits       = ${arr(path2.bits)}
send_amount    = "${toField(SEND_AMOUNT)}"
recipient_owner = "${toField(okRecip)}"
recipient_blinding = "${toField(outRecipBlinding)}"
change_blinding = "${toField(outChangeBlinding)}"
fee_out_blinding = "${toField(outFeeBlinding)}"
fee_change_blinding = "${toField(outFeeChgBlinding)}"
elig_siblings  = ${arr(eligSiblings)}
elig_bits      = ${arr(eligBits)}
`;
}

// ── Build post-transfer tree for B's withdraw ─────────────────────────────────

// After the transfer, tree has 7 leaves: 0,1,2 (inputs, consumed) + 3,4,5,6 (outputs)
// But the input commitments are STILL in the tree (they can't be removed).
// The post-transfer root is computed by inserting outputs into the 3-leaf tree.
const postTransferLeaves7 = [cmtA0, cmtA1, cmtFee, outRecipCmt, outChangeCmt, outFeeCmt, outFeeChgCmt];
const { paths: postPaths, finalRoot: rootAfterTransfer } = buildCorrect(postTransferLeaves7);

// B's note is at index 3 (outRecipCmt). We need the path for index 3 in the 7-leaf tree.
// Use the efficient method for the 7-leaf case:
function pathFor7(leaves: bigint[], idx: number): { siblings: bigint[]; bits: bigint[]; root: bigint } {
  // Use buildCorrect which gives us the path at INSERTION TIME.
  // For a ZK proof, we need the path against the CURRENT root (after all 7 leaves).
  // Use pathAgainstRoot3Efficient analog but for 7 leaves.
  // Since idx=3 was inserted when the tree had [0,1,2,3], its insertion-time path
  // computes root of [0,1,2,3]. But we need path against root-of-7.
  // We'll compute it manually.
  const z = zeros;
  const l = leaves;
  // Level-0 nodes at relevant positions:
  // idx=3 => pos=3 => bits = [1,1,0,0,...] (binary 011 reversed = bit0=1,bit1=1,bit2=0...)
  // Wait: 3 in binary is 11 = bits[0]=1, bits[1]=1, rest=0

  // Level 1: pairs (0,1), (2,3), (4,5), (6,z[0])
  const p01 = hash2(l[0], l[1]);
  const p23 = hash2(l[2], l[3]);
  const p45 = hash2(l[4], l[5]);
  const p6z = hash2(l[6], z[0]);

  // Level 2: pairs (p01,p23), (p45,p6z)
  const p0123 = hash2(p01, p23);
  const p4567 = hash2(p45, p6z);

  // Level 3: pair (p0123, p4567)
  const p01234567 = hash2(p0123, p4567);

  // Level 4+: hash with zeros
  let root = p01234567;
  for (let i = 3; i < DEPTH; i++) root = hash2(root, z[i]);

  // Path for idx=3 (binary: bit0=1, bit1=1, bit2=0, ...):
  const siblings: bigint[] = new Array(DEPTH).fill(0n);
  const bits: bigint[] = new Array(DEPTH).fill(0n);
  bits[0] = 1n; siblings[0] = l[2];    // sibling of idx=3 is idx=2
  bits[1] = 1n; siblings[1] = p01;      // sibling of p23 is p01
  bits[2] = 0n; siblings[2] = p4567;    // sibling of p0123 is p4567
  for (let i = 3; i < DEPTH; i++) { bits[i] = 0n; siblings[i] = z[i]; }

  return { siblings, bits, root };
}

const pathB = pathFor7(postTransferLeaves7, 3);
const ROOT_AFTER_TRANSFER = pathB.root;

// B's nullifier
const nfB = nullifier(outRecipCmt, 11n); // B's sk=11

// ext_data_hash for B's withdraw (no fee, no change, recipient=0xbEEF)
const MEMOS_W: `0x${string}`[] = ["0xbb01"];
const EXT_WITHDRAW = extDataHash(
  MEMOS_W,
  "0x0000000000000000000000000000000000000000",  // relayer = zero (no fee)
  0n,
  RECIPIENT_B,
  CHAIN_ID,
  POOL
);

function tomlWithdraw(): string {
  return `# Pii E2E withdraw fixture — gen-e2e-fixture.ts
# B withdraws 2.5M USDC to bEEF, no fee, no change

# Public inputs (SPEC §4.1 order)
merkle_root       = "${toField(ROOT_AFTER_TRANSFER)}"
nullifier         = "${toField(nfB)}"
recipient         = "${toHex(BigInt(RECIPIENT_B), 64)}"
amount            = "${toField(2_500_000n)}"
change_commitment = "${toField(ZERO_VALUE)}"
ext_data_hash     = "${toField(EXT_WITHDRAW)}"

# Private inputs
spending_key    = "${toField(11n)}"
note_amount     = "${toField(2_500_000n)}"
note_blinding   = "${toField(outRecipBlinding)}"
merkle_siblings = ${arr(pathB.siblings)}
merkle_bits     = ${arr(pathB.bits)}
change_blinding = "${toField(0n)}"
`;
}

// ── Write files ───────────────────────────────────────────────────────────────

// Use underscores — nargo treats dots as file-extension separators and silently
// falls back to Prover.toml when the name contains a dot.
const transferProver = join(process.cwd(), "circuits/transfer/Prover_e2e.toml");
const withdrawProver = join(process.cwd(), "circuits/withdraw/Prover_e2e.toml");

writeFileSync(transferProver, tomlTransfer());
writeFileSync(withdrawProver, tomlWithdraw());

// ── Print summary ─────────────────────────────────────────────────────────────

console.log("\n=== E2E Fixture Summary ===");
console.log("USDC_ID:          ", toHex(USDC_ID));
console.log("okA (sk=7):       ", toHex(okA));
console.log("okB (sk=11):      ", toHex(okB));
console.log("okRelayer (sk=13):", toHex(okRelayer));
console.log("cmtA0 (leaf 0):   ", toHex(cmtA0));
console.log("cmtA1 (leaf 1):   ", toHex(cmtA1));
console.log("cmtFee (leaf 2):  ", toHex(cmtFee));
console.log("MERKLE_ROOT_3:    ", toHex(MERKLE_ROOT_3));
console.log("nf0:              ", toHex(nf0));
console.log("nf1:              ", toHex(nf1));
console.log("nfFee:            ", toHex(nfFee));
console.log("outRecipCmt(leaf3):", toHex(outRecipCmt));
console.log("outChangeCmt(l4): ", toHex(outChangeCmt));
console.log("outFeeCmt(leaf5): ", toHex(outFeeCmt));
console.log("outFeeChgCmt(l6): ", toHex(outFeeChgCmt));
console.log("ROOT_AFTER_TRANSFER:", toHex(ROOT_AFTER_TRANSFER));
console.log("nfB:              ", toHex(nfB));
console.log("EXT_TRANSFER:     ", toHex(EXT_TRANSFER));
console.log("EXT_WITHDRAW:     ", toHex(EXT_WITHDRAW));
console.log("EMPTY_ROOT:       ", toHex(EMPTY_ROOT));
console.log("\nWrote:", transferProver);
console.log("Wrote:", withdrawProver);
