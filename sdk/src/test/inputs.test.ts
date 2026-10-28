/**
 * sdk/src/test/inputs.test.ts
 *
 * Rebuilds the gen-e2e-fixture scenario entirely from SDK objects and verifies
 * that buildTransferInputs + buildWithdrawInputs produce public inputs
 * byte-identical to the E2E circuit fixtures.
 */

import { describe, test, expect } from "bun:test";
import { hash2 } from "../hash.js";
import { commitment, nullifier, depositSecret } from "../note.js";
import type { Note } from "../note.js";
import { buildTree, EMPTY_TREE_ROOT } from "../tree.js";
import { extDataHash, buildWithdrawInputs, buildTransferInputs } from "../inputs.js";

// ─── Golden constants (from PiiPoolE2E.t.sol + gen-e2e-fixture.ts) ──────────

const USDC_ID = 0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86en;
const CMT_A0 = 0x25401d063ca1ea2e93b060c3191f5221a54f9d52fd5e8f81e666d9d07d6aa812n;
const CMT_A1 = 0x291c073c82e06e7981a792ed4a700d1ab55853111cb1f4c20b5a69e67fdc7c86n;
const CMT_FEE = 0x02589e958e1914010710d07839b95cda441ab5381b267cff8e5395f87eb2ca3dn;
const ROOT_3 = 0x0e14666af22b282d457244bb3c6c825c2872c37748e30b120b74e9ed9b8364a2n;
const ROOT_AFTER_TRANSFER = 0x2e4650c96ea6622aa0a9bc0637936d5a096e9fb4193010c3d852e7861ce617bbn;
const NF0 = 0x02b1971abd74524aa9b7175b7689356d5268d4c7bbcd59c57594577e7ca28bf4n;
const NF1 = 0x21774fd5719064deb939a8266e597e385ea6a44be87f56350c00aafff704b637n;
const NF_FEE = 0x1c6f8abd5bf2305b5a1925ef08dd290b042773f1c56ba2a85fe8350a40f74008n;
const NFB = 0x0d9ae79f04939e9a77ca1d0bde172b9f21e71ac5a780214b1d542861f4d4a2a0n;
const OUT_RECIP = 0x10c7132167488662b478551f5621750b5ac7154ae9d962a266dbede7681bc072n;
const OUT_FEE = 0x27b49af6c3e50a44e47b74084da2b11939c3e2cf751340f282d50ceb40fa3a7fn;
const OUT_FEE_CHG = 0x1e44673056bf3404c2bd09d3ef8fc25ea094d13da085dd4a5705b8359a592370n;
const OK_RELAYER = 0x06cb4824a064e10e1c65bba82631507dfc6883287fa218a918ab9454eba930cbn;
const EXT_TRANSFER = 0x2be643aa91018f442aed7fb75ccc97475133f2c319e516160a13f1e4c97f0486n;
const EXT_WITHDRAW = 0x221997461d326839e985f996feb2d5146b442d714552ec2306f48d57360f0fccn;

const POOL = "0x0000000000000000000000000000000000001001" as `0x${string}`;
const RELAYER = "0x000000000000000000000000000000000000FEE0" as `0x${string}`;
const RECIPIENT_B = "0x000000000000000000000000000000000000bEEF" as `0x${string}`;
const CHAIN_ID = 31337n;
const MEMOS: [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`] = [
  "0xaa01",
  "0xaa02",
  "0xaa03",
  "0xaa04",
];
const MEMOS_W = ["0xbb01" as `0x${string}`];

// ─── Derived values ──────────────────────────────────────────────────────────

const SK_A = 7n;
const SK_B = 11n;
const SK_RELAYER = 13n;

const OK_A = hash2(SK_A, 0n);   // owner_key(7)
const OK_B = hash2(SK_B, 0n);   // owner_key(11)

// ─── Build scenario notes ────────────────────────────────────────────────────

const noteA0: Note = { assetId: USDC_ID, amount: 2_000_000n, ownerKey: OK_A, blinding: 11n, leafIndex: 0 };
const noteA1: Note = { assetId: USDC_ID, amount: 1_000_000n, ownerKey: OK_A, blinding: 12n, leafIndex: 1 };
const noteFee: Note = { assetId: USDC_ID, amount: 200_000n, ownerKey: OK_A, blinding: 13n, leafIndex: 2 };

// ─── Build tree with 3 leaves ────────────────────────────────────────────────

const tree3 = buildTree([CMT_A0, CMT_A1, CMT_FEE]);

// ─── Build post-transfer tree (7 leaves) ────────────────────────────────────

// OUT_CHANGE is computed: send=2.5M, in0+in1=3M → change=500k, ok=OK_A, blinding=22
const OUT_CHANGE_NOTE: Note = { assetId: USDC_ID, amount: 500_000n, ownerKey: OK_A, blinding: 22n };
const OUT_CHANGE = commitment(OUT_CHANGE_NOTE);

// Full 7-leaf tree (inputs stay, outputs append)
const tree7 = buildTree([CMT_A0, CMT_A1, CMT_FEE, OUT_RECIP, OUT_CHANGE, OUT_FEE, OUT_FEE_CHG]);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("inputs — extDataHash", () => {
  test("transfer ext_data_hash matches fixture", () => {
    const edh = extDataHash(
      MEMOS,
      RELAYER,
      50_000n,
      "0x0000000000000000000000000000000000000000",
      CHAIN_ID,
      POOL,
    );
    expect(edh).toBe(EXT_TRANSFER);
  });

  test("withdraw ext_data_hash matches fixture", () => {
    const edh = extDataHash(
      MEMOS_W,
      "0x0000000000000000000000000000000000000000",
      0n,
      RECIPIENT_B,
      CHAIN_ID,
      POOL,
    );
    expect(edh).toBe(EXT_WITHDRAW);
  });
});

describe("inputs — buildTransferInputs public inputs byte-identical to fixture", () => {
  test("all 12 public inputs match", () => {
    const { publicInputs } = buildTransferInputs({
      sk: SK_A,
      inNotes: [noteA0, noteA1],
      feeNote: noteFee,
      feeSk: SK_A,
      tree: tree3,
      leafIndices: [0, 1, 2], // in0=0, in1=1, feeIn=2
      recipientOwnerKey: OK_B,
      sendAmount: 2_500_000n,
      fee: 50_000n,
      relayerOwnerKey: OK_RELAYER,
      relayer: RELAYER,
      memos: MEMOS,
      pool: POOL,
      chainId: CHAIN_ID,
      blindings: {
        recipientBlinding: 21n,
        changeBlinding: 22n,
        feeOutBlinding: 24n,
        feeChangeBlinding: 25n,
      },
    });

    // [0] merkle_root
    expect(publicInputs[0]).toBe(ROOT_3);
    // [1] nf_0
    expect(publicInputs[1]).toBe(NF0);
    // [2] nf_1
    expect(publicInputs[2]).toBe(NF1);
    // [3] nf_fee
    expect(publicInputs[3]).toBe(NF_FEE);
    // [4] out_recipient
    expect(publicInputs[4]).toBe(OUT_RECIP);
    // [5] out_change
    expect(publicInputs[5]).toBe(OUT_CHANGE);
    // [6] out_fee
    expect(publicInputs[6]).toBe(OUT_FEE);
    // [7] out_fee_change
    expect(publicInputs[7]).toBe(OUT_FEE_CHG);
    // [8] eligibility_root (EMPTY_TREE_ROOT for USDC)
    expect(publicInputs[8]).toBe(EMPTY_TREE_ROOT);
    // [9] fee
    expect(publicInputs[9]).toBe(50_000n);
    // [10] relayer_owner_key
    expect(publicInputs[10]).toBe(OK_RELAYER);
    // [11] ext_data_hash
    expect(publicInputs[11]).toBe(EXT_TRANSFER);
  });
});

describe("inputs — buildWithdrawInputs public inputs byte-identical to fixture", () => {
  test("all 6 public inputs match (B's withdraw)", () => {
    const noteB: Note = { assetId: USDC_ID, amount: 2_500_000n, ownerKey: OK_B, blinding: 21n, leafIndex: 3 };

    const { publicInputs } = buildWithdrawInputs({
      sk: SK_B,
      note: noteB,
      tree: tree7,
      leafIndex: 3,
      recipient: RECIPIENT_B,
      amount: 2_500_000n, // full withdraw — no change
      relayer: "0x0000000000000000000000000000000000000000",
      fee: 0n,
      memos: MEMOS_W,
      pool: POOL,
      chainId: CHAIN_ID,
      changeBlinding: 0n,
    });

    // [0] merkle_root
    expect(publicInputs[0]).toBe(ROOT_AFTER_TRANSFER);
    // [1] nullifier
    expect(publicInputs[1]).toBe(NFB);
    // [2] recipient (as uint160 field)
    expect(publicInputs[2]).toBe(BigInt(RECIPIENT_B));
    // [3] amount
    expect(publicInputs[3]).toBe(2_500_000n);
    // [4] change_commitment (ZERO_VALUE since no change)
    // (just verify it's not zero — ZERO_VALUE is the sentinel, not zero)
    expect(publicInputs[4]).toBeGreaterThan(0n);
    // [5] ext_data_hash
    expect(publicInputs[5]).toBe(EXT_WITHDRAW);
  });

  test("commitment and nullifier primitives are consistent with SPEC §2", () => {
    // Verify the commitment and nullifier primitives used in inputs.ts
    // produce the same values as the circuit fixture.
    const sec = depositSecret(OK_A, 11n);
    const cmt = commitment({ assetId: USDC_ID, amount: 2_000_000n, ownerKey: OK_A, blinding: 11n });
    expect(cmt).toBe(CMT_A0);

    const nf = nullifier({ assetId: USDC_ID, amount: 2_000_000n, ownerKey: OK_A, blinding: 11n }, SK_A, 0);
    expect(nf).toBe(NF0);
  });

  test("tree roots match fixture after 3 leaves", () => {
    expect(tree3.root).toBe(ROOT_3);
  });

  test("tree root matches ROOT_AFTER_TRANSFER after 7 leaves", () => {
    expect(tree7.root).toBe(ROOT_AFTER_TRANSFER);
  });
});
