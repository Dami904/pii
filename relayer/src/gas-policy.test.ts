/**
 * relayer/src/gas-policy.test.ts
 */

import { describe, expect, test } from "bun:test";
import { decideRelay, opCostWei, parseUsdcToWei } from "./gas-policy.js";

const GWEI = 10n ** 9n;
const PRICE = 20n * GWEI; // 20 gwei
const usdc = (s: string) => parseUsdcToWei(s);

describe("parseUsdcToWei", () => {
  test("parses plain and decimal amounts at 18 decimals", () => {
    expect(parseUsdcToWei("1")).toBe(10n ** 18n);
    expect(parseUsdcToWei("0.25")).toBe(25n * 10n ** 16n);
    expect(parseUsdcToWei("0.000000000000000001")).toBe(1n);
  });
});

describe("opCostWei", () => {
  test("a payment costs about 0.15 USDC with the safety margin at 20 gwei, a withdrawal about 0.09", () => {
    expect(Number(opCostWei("transfer", PRICE)) / 1e18).toBeCloseTo(0.1512, 3);
    expect(Number(opCostWei("withdraw", PRICE)) / 1e18).toBeCloseTo(0.0912, 3);
  });
});

describe("decideRelay", () => {
  const reserve = usdc("0.25");

  test("plenty of gas: both are allowed", () => {
    expect(decideRelay("transfer", usdc("2"), PRICE, reserve).ok).toBe(true);
    expect(decideRelay("withdraw", usdc("2"), PRICE, reserve).ok).toBe(true);
  });

  test("below cost + reserve: payments stop, but withdrawals still go through", () => {
    const bal = usdc("0.30"); // less than 0.15 + 0.25, more than a withdrawal's 0.09
    expect(decideRelay("transfer", bal, PRICE, reserve).ok).toBe(false);
    expect(decideRelay("withdraw", bal, PRICE, reserve).ok).toBe(true);
  });

  test("too little even for a withdrawal: both are refused with a clear message", () => {
    const d = decideRelay("withdraw", usdc("0.05"), PRICE, reserve);
    expect(d.ok).toBe(false);
    expect(!d.ok && d.message).toContain("out of gas");
    const t = decideRelay("transfer", usdc("0.05"), PRICE, reserve);
    expect(!t.ok && t.message).toContain("only relaying withdrawals");
  });

  test("a higher gas price makes the same balance buy less", () => {
    const bal = usdc("0.45");
    expect(decideRelay("transfer", bal, PRICE, reserve).ok).toBe(true);
    expect(decideRelay("transfer", bal, PRICE * 3n, reserve).ok).toBe(false);
  });
});
