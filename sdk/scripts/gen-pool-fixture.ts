/**
 * gen-pool-fixture.ts
 * Generates circuits/withdraw/Prover.toml for the PiiPool integration test.
 *
 * Scenario:
 *   - USDC = 0x3600000000000000000000000000000000000000
 *   - USDC_ID = hash2(uint160(USDC), 0)
 *   - sk = 7, blinding = 999, amount = 5_000_000 (5 USDC)
 *   - secret = hash2(owner_key(7), 999)
 *   - commitment = hash3(USDC_ID, 5_000_000, secret)  <- matches what PiiPool.deposit computes
 *   - Tree: one leaf at index 0 (the deposit above)
 *   - Withdraw: amount = 3_000_000, change = 2_000_000
 *   - Recipient: 0x000000000000000000000000000000000000bEEF
 *   - Relayer:   0x000000000000000000000000000000000000fEE0
 *   - Fee:       100_000
 *   - change_blinding = 1234
 *   - Memos: [0xc0ffee]  (3-byte payload)
 *   - chainid = 31337, pool = 0x0000000000000000000000000000000000001001
 *
 * Outputs Prover.toml to circuits/withdraw/ and prints the public inputs.
 * Also writes contracts/test/fixtures/pool_withdraw_{proof,public_inputs}.bin
 * after prove.sh is run (prove.sh is invoked separately).
 */

import { poseidon2Hash } from "@zkpassport/poseidon2";
import { keccak256, encodeAbiParameters, parseAbiParameters } from "viem";
import { writeFileSync } from "fs";
import { join } from "path";

const r = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function h2(a: bigint, b: bigint): bigint { return poseidon2Hash([a, b]); }
function h3(a: bigint, b: bigint, c: bigint): bigint { return poseidon2Hash([a, b, c]); }

const ZERO_VALUE =
  BigInt("0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466");

function computeZeros(): bigint[] {
  const z: bigint[] = new Array(21);
  z[0] = ZERO_VALUE;
  for (let i = 1; i <= 20; i++) z[i] = h2(z[i-1], z[i-1]);
  return z;
}

function ownerKey(sk: bigint): bigint { return h2(sk, 0n); }
function noteSecret(ok: bigint, blinding: bigint): bigint { return h2(ok, blinding); }
function noteCommitment(assetId: bigint, amount: bigint, secret: bigint): bigint {
  return h3(assetId, amount, secret);
}

// ── USDC_ID ──────────────────────────────────────────────────────────────────
const USDC_ADDR = 0x3600000000000000000000000000000000000000n;
const USDC_ID = h2(USDC_ADDR, 0n);

// ── Note ─────────────────────────────────────────────────────────────────────
const SK    = 7n;
const BLIND = 999n;
const AMOUNT = 5_000_000n;
const OK    = ownerKey(SK);
const SEC   = noteSecret(OK, BLIND);
const CMT   = noteCommitment(USDC_ID, AMOUNT, SEC);

// ── Build depth-20 tree with one leaf at index 0 ─────────────────────────────
const zeros = computeZeros();
const siblings: bigint[] = new Array(20);
const bits: bigint[] = new Array(20).fill(0n);
siblings[0] = zeros[0]; // leaf at index 0 — left child, sibling is zeros[0]
for (let i = 1; i < 20; i++) siblings[i] = zeros[i];

// Compute root: hash up the chain with bits all 0
let cur = CMT;
for (let i = 0; i < 20; i++) cur = h2(cur, zeros[i]);
const ROOT = cur;

// ── Withdraw parameters ───────────────────────────────────────────────────────
const WITHDRAW_AMOUNT  = 3_000_000n;
const CHANGE_AMOUNT    = AMOUNT - WITHDRAW_AMOUNT; // 2_000_000
const CHANGE_BLIND     = 1234n;
const CHANGE_SECRET    = noteSecret(OK, CHANGE_BLIND);
const CHANGE_CMT       = noteCommitment(USDC_ID, CHANGE_AMOUNT, CHANGE_SECRET);
const NULLIFIER        = h2(CMT, SK);

const RECIPIENT   = 0x000000000000000000000000000000000000bEEFn;
const RELAYER     = 0x000000000000000000000000000000000000fEE0n;
const FEE         = 100_000n;
const CHAIN_ID    = 31337n;
const POOL        = 0x0000000000000000000000000000000000001001n;

// ── ext_data_hash = keccak256(abi.encode(memos, relayer, fee, recipient, chainid, pool)) % r ──
// This must match the contract's abi.encode(memos, relayer, fee, recipient, block.chainid, address(this))
// where memos is bytes[] (NOT pre-encoded).
const fullEncoded = encodeAbiParameters(
  parseAbiParameters("bytes[], address, uint256, address, uint256, address"),
  [
    ["0xc0ffee"],
    `0x${RELAYER.toString(16).padStart(40, "0")}` as `0x${string}`,
    FEE,
    `0x${RECIPIENT.toString(16).padStart(40, "0")}` as `0x${string}`,
    CHAIN_ID,
    `0x${POOL.toString(16).padStart(40, "0")}` as `0x${string}`,
  ]
);
const EXT_DATA_HASH = BigInt(keccak256(fullEncoded)) % r;

// ── Prover.toml ────────────────────────────────────────────────────────────────
function f(x: bigint): string { return `"0x${x.toString(16).padStart(64, "0")}"` }

const siblingsToml = siblings.map(s => f(s)).join(", ");
const bitsToml     = bits.map(b => `"0x${b.toString(16).padStart(64, "0")}"`).join(", ");

const toml = `# Pii pool withdraw fixture — gen-pool-fixture.ts
# Scenario: deposit 5 USDC, withdraw 3 USDC to bEEF, relayer fEE0, fee 100k, change 2 USDC

# Public inputs (SPEC §4.1 order)
merkle_root       = ${f(ROOT)}
nullifier         = ${f(NULLIFIER)}
recipient         = ${f(RECIPIENT)}
amount            = ${f(WITHDRAW_AMOUNT)}
change_commitment = ${f(CHANGE_CMT)}
ext_data_hash     = ${f(EXT_DATA_HASH)}

# Private inputs
spending_key    = ${f(SK)}
note_amount     = ${f(AMOUNT)}
note_blinding   = ${f(BLIND)}
merkle_siblings = [${siblingsToml}]
merkle_bits     = [${bitsToml}]
change_blinding = ${f(CHANGE_BLIND)}
`;

// Use underscore — nargo treats dots as file-extension separators.
const tomlPath = join(import.meta.dir, "../../circuits/withdraw/Prover_pool.toml");
writeFileSync(tomlPath, toml, "utf8");
console.log("Wrote", tomlPath);
console.log(`merkle_root       = ${f(ROOT)}`);
console.log(`nullifier         = ${f(NULLIFIER)}`);
console.log(`recipient         = ${f(RECIPIENT)}`);
console.log(`amount            = ${f(WITHDRAW_AMOUNT)}`);
console.log(`change_commitment = ${f(CHANGE_CMT)}`);
console.log(`ext_data_hash     = ${f(EXT_DATA_HASH)}`);
console.log(`USDC_ID           = ${f(USDC_ID)}`);
console.log(`commitment        = ${f(CMT)}`);
console.log(`ZERO_VALUE        = ${f(ZERO_VALUE)}`);
