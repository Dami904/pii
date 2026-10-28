/**
 * sdk/src/test/tx.test.ts
 * Tests for submitAndTrack outcome logic.
 */

import { describe, test, expect } from "bun:test";
import { submitAndTrack } from "../tx.js";
import type { TransactionReceipt, PublicClientForTx, PoolNullifierReader } from "../tx.js";

const HASH = "0xdeadbeef00000000000000000000000000000000000000000000000000000001" as `0x${string}`;
const NF1 = 1n;
const NF2 = 2n;

function makeClient(receipt: TransactionReceipt | "timeout"): PublicClientForTx {
  return {
    async waitForTransactionReceipt() {
      if (receipt === "timeout") throw new Error("Timeout");
      return receipt;
    },
  };
}

function makePool(spentNullifiers: Set<bigint>): PoolNullifierReader {
  return {
    read: {
      async nullifierSpent([nf]) { return spentNullifiers.has(nf); },
    },
  };
}

describe("submitAndTrack", () => {
  test("returns confirmed on success receipt", async () => {
    const result = await submitAndTrack(
      async () => HASH,
      [NF1],
      makePool(new Set()),
      makeClient({ status: "success" })
    );
    expect(result).toBe("confirmed");
  });

  test("returns failed on reverted receipt", async () => {
    const result = await submitAndTrack(
      async () => HASH,
      [NF1],
      makePool(new Set()),
      makeClient({ status: "reverted" })
    );
    expect(result).toBe("failed");
  });

  test("returns failed when sendFn throws (wallet rejection)", async () => {
    const result = await submitAndTrack(
      async () => { throw new Error("user rejected"); },
      [NF1],
      makePool(new Set()),
      makeClient({ status: "success" })
    );
    expect(result).toBe("failed");
  });

  test("returns confirmed on timeout when all nullifiers are spent", async () => {
    const result = await submitAndTrack(
      async () => HASH,
      [NF1, NF2],
      makePool(new Set([NF1, NF2])), // both spent
      makeClient("timeout")
    );
    expect(result).toBe("confirmed");
  });

  test("returns unknown on timeout when nullifiers are NOT spent", async () => {
    const result = await submitAndTrack(
      async () => HASH,
      [NF1, NF2],
      makePool(new Set()), // none spent
      makeClient("timeout")
    );
    expect(result).toBe("unknown");
  });

  test("returns unknown on timeout when SOME (not all) nullifiers are spent", async () => {
    const result = await submitAndTrack(
      async () => HASH,
      [NF1, NF2],
      makePool(new Set([NF1])), // only NF1 spent
      makeClient("timeout")
    );
    expect(result).toBe("unknown");
  });

  test("returns unknown on timeout with empty nullifiers list", async () => {
    const result = await submitAndTrack(
      async () => HASH,
      [], // no nullifiers to check
      makePool(new Set()),
      makeClient("timeout")
    );
    expect(result).toBe("unknown");
  });

  test("returns unknown when pool RPC fails after timeout", async () => {
    const brokenPool: PoolNullifierReader = {
      read: {
        async nullifierSpent() { throw new Error("RPC down"); },
      },
    };
    const result = await submitAndTrack(
      async () => HASH,
      [NF1],
      brokenPool,
      makeClient("timeout")
    );
    expect(result).toBe("unknown");
  });
});
