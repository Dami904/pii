/**
 * sdk/src/test/keys.test.ts
 * Tests for key derivation determinism and correctness.
 */

import { describe, test, expect } from "bun:test";
import { deriveKeys, checkDeterministic, keysFromSignature } from "../keys.js";
import { hash2 } from "../hash.js";

// A fixed 65-byte ECDSA signature (r, s, v) — arbitrary but stable.
const FIXED_SIG: `0x${string}` =
  "0x" +
  "1c8c3ca0b3a3d75850fcd4dc7bf1e3445cd0cfff3ca510630fd90b47e8a24755".repeat(2) +
  "1b";

describe("keys — deriveKeys", () => {
  test("keysFromSignature is deterministic for a fixed signature", () => {
    const k1 = keysFromSignature(FIXED_SIG);
    const k2 = keysFromSignature(FIXED_SIG);
    expect(k1.sk).toBe(k2.sk);
    expect(k1.ownerKey).toBe(k2.ownerKey);
  });

  test("sk is non-zero", () => {
    const { sk } = keysFromSignature(FIXED_SIG);
    expect(sk).toBeGreaterThan(0n);
  });

  test("ownerKey = hash2(sk, 0)", () => {
    const { sk, ownerKey } = keysFromSignature(FIXED_SIG);
    expect(ownerKey).toBe(hash2(sk, 0n));
  });

  test("deriveKeys calls signTypedData with the right domain and type", async () => {
    const calls: unknown[] = [];
    const mockSign = async (args: unknown): Promise<`0x${string}`> => {
      calls.push(args);
      return FIXED_SIG;
    };
    const keys = await deriveKeys(mockSign as Parameters<typeof deriveKeys>[0], 31337);
    // Called twice (determinism check)
    expect(calls.length).toBe(2);
    // Domain fields
    const arg = calls[0] as { domain: { name: string; version: string; chainId: number } };
    expect(arg.domain.name).toBe("Pii");
    expect(arg.domain.version).toBe("1");
    expect(arg.domain.chainId).toBe(31337);
    // Keys must match keysFromSignature
    const expected = keysFromSignature(FIXED_SIG);
    expect(keys.sk).toBe(expected.sk);
    expect(keys.ownerKey).toBe(expected.ownerKey);
  });

  test("checkDeterministic does NOT throw when signatures match", () => {
    expect(() => checkDeterministic(FIXED_SIG, FIXED_SIG)).not.toThrow();
  });

  test("checkDeterministic throws a clear error when signatures differ", () => {
    const sig2: `0x${string}` = ("0x" + "ab".repeat(65)) as `0x${string}`;
    expect(() => checkDeterministic(FIXED_SIG, sig2)).toThrow(
      "non-deterministically"
    );
  });

  test("deriveKeys throws when mock returns different signatures", async () => {
    let count = 0;
    const mockSign = async (): Promise<`0x${string}`> => {
      count++;
      return count === 1 ? FIXED_SIG : (("0x" + "ab".repeat(65)) as `0x${string}`);
    };
    await expect(
      deriveKeys(mockSign as Parameters<typeof deriveKeys>[0], 1)
    ).rejects.toThrow("non-deterministically");
  });
});
