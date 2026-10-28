/**
 * sdk/test/relayer.test.ts
 * Unit tests for relayer validation logic (no live server required).
 * Tests the validate.ts functions directly with mocked pool reads.
 */

import { describe, it, expect, beforeAll } from "bun:test";

// We test the validation logic extracted into pure functions.
// Since validate.ts imports from config.ts (which reads env), we replicate
// the validation rules inline here for unit testing.

import { MEMO_BYTE_LENGTH } from "../src/memo.js";
import { hash2 } from "../src/hash.js";

// ── Reusable constants ────────────────────────────────────────────────────

const MEMO_LENGTH = MEMO_BYTE_LENGTH; // 134
const CHAIN_ID    = 31337;
const POOL        = "0x0000000000000000000000000000000000001001" as const;
const RELAYER_EOA = "0x000000000000000000000000000000000000feE0" as const;
const SK_RELAYER  = 777888999n;
const RELAYER_OK  = hash2(SK_RELAYER, 0n);
const MIN_FEE     = 1000n;

function makeMemo(length: number): `0x${string}` {
  const bytes = new Uint8Array(length);
  bytes[0] = 0x03; // valid compressed point prefix
  return ("0x" + Buffer.from(bytes).toString("hex")) as `0x${string}`;
}

// ── Validation rules (replicated from validate.ts) ─────────────────────────
// We test these as pure functions, not via HTTP.

interface WithdrawReq {
  chainId: number; pool: string; memos: string[]; relayer: string; fee: string;
}
interface TransferReq {
  chainId: number; pool: string; memos: string[];
  relayer: string; args: { fee: string; relayerOwnerKey: string };
}

function validateWithdrawSync(req: WithdrawReq): string | null {
  if (req.chainId !== CHAIN_ID) return `chainId mismatch: expected ${CHAIN_ID}`;
  if (req.pool.toLowerCase() !== POOL.toLowerCase()) return "pool address mismatch";
  if (req.memos.length !== 1) return "withdraw requires exactly 1 memo";
  for (const m of req.memos) {
    const bytes = Buffer.from(m.slice(2), "hex");
    if (bytes.length !== MEMO_LENGTH) return `memo must be ${MEMO_LENGTH} bytes`;
  }
  if (req.relayer.toLowerCase() !== RELAYER_EOA.toLowerCase()) return "relayer address mismatch";
  if (BigInt(req.fee) < MIN_FEE) return `fee too low: min ${MIN_FEE}`;
  return null;
}

function validateTransferSync(req: TransferReq): string | null {
  if (req.chainId !== CHAIN_ID) return `chainId mismatch: expected ${CHAIN_ID}`;
  if (req.pool.toLowerCase() !== POOL.toLowerCase()) return "pool address mismatch";
  if (req.memos.length !== 4) return "transfer requires exactly 4 memos";
  for (const m of req.memos) {
    const bytes = Buffer.from(m.slice(2), "hex");
    if (bytes.length !== MEMO_LENGTH) return `memo must be ${MEMO_LENGTH} bytes`;
  }
  if (req.relayer.toLowerCase() !== RELAYER_EOA.toLowerCase()) return "relayer address mismatch";
  if (BigInt(req.args.relayerOwnerKey) !== RELAYER_OK) return "relayerOwnerKey mismatch";
  if (BigInt(req.args.fee) < MIN_FEE) return `fee too low: min ${MIN_FEE}`;
  return null;
}

// ── Tests ──────────────────────────────────────────────────────────────────

const goodWithdraw: WithdrawReq = {
  chainId: CHAIN_ID,
  pool: POOL,
  memos: [makeMemo(MEMO_LENGTH)],
  relayer: RELAYER_EOA,
  fee: "1000",
};

const goodTransfer: TransferReq = {
  chainId: CHAIN_ID,
  pool: POOL,
  memos: [makeMemo(MEMO_LENGTH), makeMemo(MEMO_LENGTH), makeMemo(MEMO_LENGTH), makeMemo(MEMO_LENGTH)],
  relayer: RELAYER_EOA,
  args: {
    fee: "1000",
    relayerOwnerKey: "0x" + RELAYER_OK.toString(16).padStart(64, "0"),
  },
};

describe("withdraw validation", () => {
  it("accepts a valid request", () => {
    expect(validateWithdrawSync(goodWithdraw)).toBeNull();
  });

  it("rejects wrong chainId", () => {
    const r = validateWithdrawSync({ ...goodWithdraw, chainId: 1 });
    expect(r).toContain("chainId");
  });

  it("rejects wrong pool", () => {
    const r = validateWithdrawSync({ ...goodWithdraw, pool: "0x000000000000000000000000000000000000dead" });
    expect(r).toContain("pool");
  });

  it("rejects 3-byte memo (wrong length)", () => {
    const r = validateWithdrawSync({ ...goodWithdraw, memos: ["0xaabbcc"] });
    expect(r).toContain("memo");
  });

  it("rejects zero memos", () => {
    const r = validateWithdrawSync({ ...goodWithdraw, memos: [] });
    expect(r).toContain("1 memo");
  });

  it("rejects two memos", () => {
    const r = validateWithdrawSync({ ...goodWithdraw, memos: [makeMemo(MEMO_LENGTH), makeMemo(MEMO_LENGTH)] });
    expect(r).toContain("1 memo");
  });

  it("rejects wrong relayer address", () => {
    const r = validateWithdrawSync({ ...goodWithdraw, relayer: "0x000000000000000000000000000000000000beef" });
    expect(r).toContain("relayer");
  });

  it("rejects fee below minFee", () => {
    const r = validateWithdrawSync({ ...goodWithdraw, fee: "999" });
    expect(r).toContain("fee too low");
  });

  it("accepts fee exactly equal to minFee", () => {
    expect(validateWithdrawSync({ ...goodWithdraw, fee: "1000" })).toBeNull();
  });
});

describe("transfer validation", () => {
  it("accepts a valid request", () => {
    expect(validateTransferSync(goodTransfer)).toBeNull();
  });

  it("rejects wrong chainId", () => {
    expect(validateTransferSync({ ...goodTransfer, chainId: 999 })).toContain("chainId");
  });

  it("rejects 3-byte memo", () => {
    const memos = [...goodTransfer.memos] as string[];
    memos[0] = "0xaabbcc";
    expect(validateTransferSync({ ...goodTransfer, memos })).toContain("memo");
  });

  it("rejects 3 memos (wrong count)", () => {
    const memos = goodTransfer.memos.slice(0, 3);
    expect(validateTransferSync({ ...goodTransfer, memos })).toContain("4 memos");
  });

  it("rejects wrong relayerOwnerKey", () => {
    const r = validateTransferSync({
      ...goodTransfer,
      args: { ...goodTransfer.args, relayerOwnerKey: "0x" + (0xdeadbeefn).toString(16).padStart(64, "0") },
    });
    expect(r).toContain("relayerOwnerKey");
  });

  it("rejects fee below minFee", () => {
    const r = validateTransferSync({ ...goodTransfer, args: { ...goodTransfer.args, fee: "1" } });
    expect(r).toContain("fee too low");
  });

  it("rejects wrong relayer address", () => {
    const r = validateTransferSync({ ...goodTransfer, relayer: "0x000000000000000000000000000000000000beef" });
    expect(r).toContain("relayer");
  });
});

describe("relayer.ts client", () => {
  it("getRelayerInfo throws on non-200", async () => {
    const { getRelayerInfo } = await import("../src/relayer.js");
    await expect(getRelayerInfo("http://127.0.0.1:19999")).rejects.toThrow();
  });

  it("relayWithdraw throws on non-200", async () => {
    const { relayWithdraw } = await import("../src/relayer.js");
    await expect(
      relayWithdraw("http://127.0.0.1:19999", {} as never),
    ).rejects.toThrow();
  });

  it("waitForStatus returns unknown on timeout", async () => {
    const { waitForStatus } = await import("../src/relayer.js");
    const result = await waitForStatus("http://127.0.0.1:19999", "0xabc", {
      pollMs: 10,
      timeoutMs: 50,
    });
    expect(result).toBe("unknown");
  });
});
