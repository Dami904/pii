/**
 * sdk/test/memo-network.test.ts
 * Pii addresses that carry their network, and the legacy form that does not.
 */

import { describe, expect, test } from "bun:test";
import { decodePiiAddress, deriveViewingKeys, encodePiiAddress } from "../src/memo.js";
import { hash2 } from "../src/hash.js";

const SK = 0x1234567890abcdefn;
const OWNER = hash2(SK, 0n);
const ENC = deriveViewingKeys(SK).encPub;

describe("Pii address with a network", () => {
  test("round-trips for both networks and returns the network", () => {
    for (const net of ["mainnet", "testnet"] as const) {
      const d = decodePiiAddress(encodePiiAddress(OWNER, ENC, net));
      expect(d.ownerKey).toBe(OWNER);
      expect(d.network).toBe(net);
      expect([...d.encPub]).toEqual([...ENC]);
    }
  });

  test("looks different per network, and starts with piim: / piit:", () => {
    const m = encodePiiAddress(OWNER, ENC, "mainnet");
    const t = encodePiiAddress(OWNER, ENC, "testnet");
    expect(m.startsWith("piim:")).toBe(true);
    expect(t.startsWith("piit:")).toBe(true);
    expect(m.slice(5, -8)).toBe(t.slice(5, -8)); // same keys...
    expect(m.slice(-8)).not.toBe(t.slice(-8));   // ...but a different checksum
  });

  test("the network cannot be switched by editing the prefix", () => {
    const m = encodePiiAddress(OWNER, ENC, "mainnet");
    expect(() => decodePiiAddress("piit:" + m.slice(5))).toThrow("checksum");
    expect(() => decodePiiAddress("pii:" + m.slice(5))).toThrow("checksum");
  });

  test("a changed character is caught", () => {
    const m = encodePiiAddress(OWNER, ENC, "mainnet");
    const bad = m.slice(0, 20) + (m[20] === "a" ? "b" : "a") + m.slice(21);
    expect(() => decodePiiAddress(bad)).toThrow();
  });
});

describe("legacy Pii address (no network)", () => {
  test("is exactly the old format and still decodes, with no network", () => {
    const legacy = encodePiiAddress(OWNER, ENC);
    expect(legacy.startsWith("pii:")).toBe(true);
    expect(legacy.length).toBe(4 + 138);
    const d = decodePiiAddress(legacy);
    expect(d.ownerKey).toBe(OWNER);
    expect(d.network).toBeUndefined();
  });

  test("a real address already in use (pasted from the testnet Portfolio) still decodes", () => {
    const real =
      "pii:27f6fc54b280f20f3a93b4c1cba500abc457df467a170d91a6e9a1169c431308038c30a206f7a14f32dd7c93d2045126f138b891e9bdb5deb676ef891bc4d02a6e39e02593";
    const d = decodePiiAddress(real);
    expect(d.network).toBeUndefined();
    expect(d.encPub.length).toBe(33);
  });

  test("the same keys as a networked address, so nothing about the money changes", () => {
    const a = decodePiiAddress(encodePiiAddress(OWNER, ENC));
    const b = decodePiiAddress(encodePiiAddress(OWNER, ENC, "mainnet"));
    expect(a.ownerKey).toBe(b.ownerKey);
    expect([...a.encPub]).toEqual([...b.encPub]);
  });

  test("garbage is still rejected", () => {
    expect(() => decodePiiAddress("0xabc")).toThrow("not a Pii address");
    expect(() => decodePiiAddress("pii:abcd")).toThrow("wrong length");
  });
});
