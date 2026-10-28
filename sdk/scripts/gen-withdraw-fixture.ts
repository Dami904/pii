/**
 * gen-withdraw-fixture.ts
 * Generates circuits/withdraw/Prover.toml for the Chunk 3+4 proof pipeline.
 *
 * Scenario (SPEC §4.1):
 *   - Tree has 2 leaves:
 *       index 0: a dummy note (another user's USDC note)
 *       index 1: a 1000-USDC note owned by spending_key = 7
 *   - Withdraw 700 USDC to recipient, leaving 300 USDC as a new shielded note.
 *
 * Run: bun sdk/scripts/gen-withdraw-fixture.ts
 * Output: circuits/withdraw/Prover.toml
 */

import { poseidon2Hash } from "@zkpassport/poseidon2";
import { writeFileSync } from "fs";
import { join } from "path";

// ── Helpers ──────────────────────────────────────────────────────────────────

const BN254_R = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617"
);

function hash2(a: bigint, b: bigint): bigint {
  return poseidon2Hash([a, b]);
}

function hash3(a: bigint, b: bigint, c: bigint): bigint {
  return poseidon2Hash([a, b, c]);
}

function toHex(v: bigint): string {
  return "0x" + v.toString(16).padStart(64, "0");
}

// ── Protocol constants ───────────────────────────────────────────────────────

const ZERO_VALUE = BigInt(
  "0x10aa41cd532efb9f2b7337c3f588d65e4af1b6c5bc76a7faa5db259c06ec2466"
);
const USDC_ADDRESS = BigInt("0x3600000000000000000000000000000000000000");

function usdc_asset_id(): bigint {
  return hash2(USDC_ADDRESS, 0n);
}

function owner_key(sk: bigint): bigint {
  return hash2(sk, 0n);
}

function note_secret(ok: bigint, blinding: bigint): bigint {
  return hash2(ok, blinding);
}

function note_commitment(asset_id: bigint, amount: bigint, secret: bigint): bigint {
  return hash3(asset_id, amount, secret);
}

function nullifier(cmt: bigint, sk: bigint): bigint {
  return hash2(cmt, sk);
}

function output_commitment(asset_id: bigint, amount: bigint, secret: bigint): bigint {
  if (amount === 0n) return ZERO_VALUE;
  return note_commitment(asset_id, amount, secret);
}

// ── Build the 2-leaf Merkle tree path for leaf at index 1 ────────────────────

function compute_zeros(): bigint[] {
  const zeros: bigint[] = new Array(21);
  zeros[0] = ZERO_VALUE;
  for (let i = 1; i <= 20; i++) {
    zeros[i] = hash2(zeros[i - 1], zeros[i - 1]);
  }
  return zeros;
}

// Replicate PiiMerkle._insert for N leaves, return all roots produced.
function build_tree_path(
  leaves: bigint[]
): { siblings: bigint[]; bits: bigint[]; root: bigint }[] {
  const zeros = compute_zeros();
  const DEPTH = 20;
  const filled: bigint[] = zeros.slice(); // filled[i] = left sibling at level i
  const results: { siblings: bigint[]; bits: bigint[]; root: bigint }[] = [];

  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    const leaf = leaves[leafIdx];
    const siblings: bigint[] = new Array(DEPTH);
    const bits: bigint[] = new Array(DEPTH);
    let cur = leaf;

    for (let i = 0; i < DEPTH; i++) {
      const bit = (leafIdx >> i) & 1;
      bits[i] = BigInt(bit);
      if (bit === 0) {
        // left child
        siblings[i] = zeros[i];
        filled[i] = cur;
        cur = hash2(cur, zeros[i]);
      } else {
        // right child
        siblings[i] = filled[i];
        cur = hash2(filled[i], cur);
      }
    }
    results.push({ siblings, bits, root: cur });
  }
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

const SPENDING_KEY = 7n;
const NOTE_AMOUNT = 1000n;
const NOTE_BLINDING = 999n;
const WITHDRAW_AMOUNT = 700n;
const CHANGE_BLINDING = 111n;
const RECIPIENT = BigInt("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
// ext_data_hash: keccak256(...) % r — use a plausible test value (will be
// replaced by the real hash when PiiPool is live; for the circuit test any
// non-zero field element is fine since no constraint touches it).
const EXT_DATA_HASH = BigInt(
  "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
) % BN254_R;

const USDC_ID = usdc_asset_id();
const OK = owner_key(SPENDING_KEY);
const SECRET = note_secret(OK, NOTE_BLINDING);
const NOTE_CMT = note_commitment(USDC_ID, NOTE_AMOUNT, SECRET);
const NF = nullifier(NOTE_CMT, SPENDING_KEY);
const CHANGE_AMT = NOTE_AMOUNT - WITHDRAW_AMOUNT; // 300
const CHANGE_SECRET = note_secret(OK, CHANGE_BLINDING);
const CHANGE_CMT = output_commitment(USDC_ID, CHANGE_AMT, CHANGE_SECRET);

// Dummy note at index 0 (another user's note, values arbitrary but valid)
const DUMMY_SK = 42n;
const DUMMY_OK = owner_key(DUMMY_SK);
const DUMMY_SECRET = note_secret(DUMMY_OK, 1n);
const DUMMY_CMT = note_commitment(USDC_ID, 500n, DUMMY_SECRET);

// Build tree with [dummy at 0, our note at 1]
const paths = build_tree_path([DUMMY_CMT, NOTE_CMT]);
const { siblings, bits, root: MERKLE_ROOT } = paths[1]; // path for index 1

// ── Validate golden vectors ───────────────────────────────────────────────────
console.log("USDC_ID:        ", toHex(USDC_ID));
console.log("owner_key(7):   ", toHex(OK));
console.log("NOTE_CMT:       ", toHex(NOTE_CMT));
console.log("NULLIFIER:      ", toHex(NF));
console.log("CHANGE_CMT:     ", toHex(CHANGE_CMT));
console.log("MERKLE_ROOT:    ", toHex(MERKLE_ROOT));

// Verify owner_key(7) golden
const EXPECTED_OK_7 = BigInt("0x0b0f697117aa52458ddd243aeeac42e2a58175474f8889f3d763521eea2ce64b");
if (OK !== EXPECTED_OK_7) throw new Error(`owner_key(7) mismatch: got ${toHex(OK)}`);
console.log("owner_key(7) golden: OK");

// ── Build Prover.toml ─────────────────────────────────────────────────────────

// Noir TOML requires large Field values as quoted hex strings
const siblingsToml = siblings.map(v => `"${toHex(v)}"`).join(", ");
const bitsToml = bits.map(v => v.toString()).join(", ");

const toml = `# Auto-generated by sdk/scripts/gen-withdraw-fixture.ts
# Scenario: 2-leaf tree, withdraw 700 from 1000-USDC note at index 1

# Public inputs (SPEC §4.1 order)
merkle_root = "${toHex(MERKLE_ROOT)}"
nullifier = "${toHex(NF)}"
recipient = "${toHex(RECIPIENT)}"
amount = "${WITHDRAW_AMOUNT}"
change_commitment = "${toHex(CHANGE_CMT)}"
ext_data_hash = "${toHex(EXT_DATA_HASH)}"

# Private inputs
spending_key = "${SPENDING_KEY}"
note_amount = "${NOTE_AMOUNT}"
note_blinding = "${NOTE_BLINDING}"
merkle_siblings = [${siblingsToml}]
merkle_bits = [${bitsToml}]
change_blinding = "${CHANGE_BLINDING}"
`;

const outPath = join(import.meta.dir, "../../circuits/withdraw/Prover.toml");
writeFileSync(outPath, toml);
console.log("\nWrote", outPath);

// Also write a JSON fixture for the forge test
const fixture = {
  merkle_root: toHex(MERKLE_ROOT),
  nullifier: toHex(NF),
  recipient: toHex(RECIPIENT),
  amount: WITHDRAW_AMOUNT.toString(),
  change_commitment: toHex(CHANGE_CMT),
  ext_data_hash: toHex(EXT_DATA_HASH),
};
const fixturePath = join(import.meta.dir, "../../contracts/test/fixtures/withdraw_inputs.json");
writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
console.log("Wrote", fixturePath);
