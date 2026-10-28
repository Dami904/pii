/**
 * gen-transfer-fixture.ts
 *
 * Builds a Prover.toml for the transfer circuit matching:
 *   in[0] = 600 USDC (sk=7), in[1] = 400 USDC (sk=8),
 *   fee_in = 50 USDC (sk=9), send=700, fee=20,
 *   eligibility_root = empty tree root (USDC transfer, no check).
 *
 * Tree layout (3 real notes at indices 0,1,2):
 *   index 0: cmt0 (600 USDC, sk=7, blinding=100)
 *   index 1: cmt1 (400 USDC, sk=8, blinding=200)
 *   index 2: fee_cmt (50 USDC, sk=9, blinding=300)
 *
 * All three membership proofs use the SAME root (the root after all 3 inserts).
 */

import { poseidon2Hash } from "@zkpassport/poseidon2";
import { writeFileSync } from "fs";
import { join } from "path";

// ── BN254 prime ──────────────────────────────────────────────────────────────
const r = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function h2(a: bigint, b: bigint): bigint {
  return poseidon2Hash([a, b]);
}
function h3(a: bigint, b: bigint, c: bigint): bigint {
  return poseidon2Hash([a, b, c]);
}

// ── ZERO_VALUE = keccak256("pii-shielded-pool-v1") % r ────────────────────────
import { keccak256, toBytes } from "viem";
const ZERO_VALUE =
  BigInt(keccak256(toBytes("pii-shielded-pool-v1"))) % r;

// ── Zeros array ───────────────────────────────────────────────────────────────
function computeZeros(): bigint[] {
  const z: bigint[] = [ZERO_VALUE];
  for (let i = 1; i <= 20; i++) z.push(h2(z[i - 1], z[i - 1]));
  return z;
}
const zeros = computeZeros();

// ── Pii primitives ────────────────────────────────────────────────────────────
function ownerKey(sk: bigint): bigint { return h2(sk, 0n); }
function noteSecret(ok: bigint, blinding: bigint): bigint { return h2(ok, blinding); }
function noteCommitment(asset: bigint, amount: bigint, secret: bigint): bigint {
  return h3(asset, amount, secret);
}
function nullifier(cmt: bigint, sk: bigint): bigint { return h2(cmt, sk); }
function outputCommitment(asset: bigint, amount: bigint, secret: bigint): bigint {
  if (amount === 0n) return ZERO_VALUE;
  return noteCommitment(asset, amount, secret);
}

// USDC asset_id = hash2(uint160(0x36000...000), 0)
const USDC_ADDR = 0x3600000000000000000000000000000000000000n;
const USDC_ID   = h2(USDC_ADDR, 0n);

// ── Build 3-leaf common-root paths ────────────────────────────────────────────
function paths3leaf(l0: bigint, l1: bigint, l2: bigint): {
  sib0: bigint[], bits0: bigint[],
  sib1: bigint[], bits1: bigint[],
  sib2: bigint[], bits2: bigint[],
  root: bigint
} {
  const p01   = h2(l0, l1);
  const p23   = h2(l2, zeros[0]);
  const p0123 = h2(p01, p23);
  let root = p0123;
  for (let i = 2; i < 20; i++) root = h2(root, zeros[i]);

  const mk = (len: number, fill: bigint) => Array(len).fill(fill);

  const sib0 = mk(20, 0n); const bits0 = mk(20, 0n);
  sib0[0] = l1; bits0[0] = 0n;
  sib0[1] = p23; bits0[1] = 0n;
  for (let i = 2; i < 20; i++) { sib0[i] = zeros[i]; bits0[i] = 0n; }

  const sib1 = mk(20, 0n); const bits1 = mk(20, 0n);
  sib1[0] = l0; bits1[0] = 1n;
  sib1[1] = p23; bits1[1] = 0n;
  for (let i = 2; i < 20; i++) { sib1[i] = zeros[i]; bits1[i] = 0n; }

  const sib2 = mk(20, 0n); const bits2 = mk(20, 0n);
  sib2[0] = zeros[0]; bits2[0] = 0n;
  sib2[1] = p01; bits2[1] = 1n;
  for (let i = 2; i < 20; i++) { sib2[i] = zeros[i]; bits2[i] = 0n; }

  return { sib0, bits0, sib1, bits1, sib2, bits2, root };
}

// ── Participants ──────────────────────────────────────────────────────────────
const sk0 = 7n;  const ok0 = ownerKey(sk0);
const sk1 = 8n;  const ok1 = ownerKey(sk1);
const feeSk = 9n; const feeOk = ownerKey(feeSk);

const cmt0    = noteCommitment(USDC_ID, 600n, noteSecret(ok0, 100n));
const cmt1    = noteCommitment(USDC_ID, 400n, noteSecret(ok1, 200n));
const feeCmt  = noteCommitment(USDC_ID,  50n, noteSecret(feeOk, 300n));

const { sib0, bits0, sib1, bits1, sib2: sfee, bits2: bfee, root } =
  paths3leaf(cmt0, cmt1, feeCmt);

const nf0   = nullifier(cmt0,   sk0);
const nf1   = nullifier(cmt1,   sk1);
const nfFee = nullifier(feeCmt, feeSk);

const sendAmt    = 700n;
const feeVal     = 20n;
const changeU    = 600n + 400n - sendAmt;  // 300
const feeChangeU = 50n - feeVal;           // 30

const recipOwner = ownerKey(42n);
const relayerOk  = ownerKey(99n);

const outRecip  = outputCommitment(USDC_ID, sendAmt,    noteSecret(recipOwner, 500n));
const outChange = outputCommitment(USDC_ID, changeU,    noteSecret(ok0, 501n));
const outFee    = outputCommitment(USDC_ID, feeVal,     noteSecret(relayerOk, 502n));
const outFch    = outputCommitment(USDC_ID, feeChangeU, noteSecret(feeOk, 503n));

// Eligibility root = empty tree (USDC transfer, no eligibility check needed)
const eligRoot = zeros[20];
const zeroSib  = Array(20).fill(0n).map((_, i) => zeros[i]);
const zeroBits = Array(20).fill(0n);

// ext_data_hash placeholder (bound only as public input)
const extDataHash = 0n;

// ── Serialise ─────────────────────────────────────────────────────────────────
function f(v: bigint): string  { return `"0x${v.toString(16)}"`;  }
function arr(a: bigint[]): string {
  return `[${a.map(f).join(", ")}]`;
}

const toml = `# Transfer circuit fixture — gen-transfer-fixture.ts
# in[0]=600 USDC sk=7, in[1]=400 USDC sk=8, fee_in=50 USDC sk=9
# send=700, fee=20, change=300, fee_change=30

merkle_root       = ${f(root)}
nf_0              = ${f(nf0)}
nf_1              = ${f(nf1)}
nf_fee            = ${f(nfFee)}
out_recipient     = ${f(outRecip)}
out_change        = ${f(outChange)}
out_fee           = ${f(outFee)}
out_fee_change    = ${f(outFch)}
eligibility_root  = ${f(eligRoot)}
fee               = ${f(feeVal)}
relayer_owner_key = ${f(relayerOk)}
ext_data_hash     = ${f(extDataHash)}

asset            = ${f(USDC_ID)}
in_amount        = [${f(600n)}, ${f(400n)}]
in_sk            = [${f(sk0)}, ${f(sk1)}]
in_blinding      = [${f(100n)}, ${f(200n)}]
in_siblings_0    = ${arr(sib0)}
in_bits_0        = ${arr(bits0)}
in_siblings_1    = ${arr(sib1)}
in_bits_1        = ${arr(bits1)}
fee_amount_in    = ${f(50n)}
fee_sk           = ${f(feeSk)}
fee_blinding_in  = ${f(300n)}
fee_siblings     = ${arr(sfee)}
fee_bits         = ${arr(bfee)}
send_amount      = ${f(sendAmt)}
recipient_owner  = ${f(recipOwner)}
recipient_blinding = ${f(500n)}
change_blinding  = ${f(501n)}
fee_out_blinding = ${f(502n)}
fee_change_blinding = ${f(503n)}
elig_siblings    = ${arr(zeroSib)}
elig_bits        = ${arr(zeroBits)}
`;

const outPath = join(import.meta.dir, "../../circuits/transfer/Prover.toml");
writeFileSync(outPath, toml);
console.log("Wrote", outPath);
console.log("merkle_root =", f(root));
console.log("nf_0        =", f(nf0));
console.log("out_recip   =", f(outRecip));
