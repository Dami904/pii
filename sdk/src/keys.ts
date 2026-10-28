/**
 * sdk/src/keys.ts
 * Derives the Pii spending key and owner key from an EIP-712 wallet signature.
 *
 * The user signs a typed message twice; if the signatures differ the wallet is
 * non-deterministic and would lose notes, so we throw immediately.
 *
 * sk  = uint256(keccak256(signature)) mod r, with a 0-guard
 * ownerKey = hash2(sk, 0)
 */

import { keccak256 } from "viem";
import { BN254_R, hash2 } from "./hash.js";

// ── EIP-712 domain + type for key derivation ──────────────────────────────────

export interface SignTypedDataFn {
  (args: {
    domain: { name: string; version: string; chainId: number };
    types: { Unlock: Array<{ name: string; type: string }> };
    primaryType: "Unlock";
    message: { purpose: string };
  }): Promise<`0x${string}`>;
}

const UNLOCK_PURPOSE =
  "Unlock my Pii private balance. Only sign this on the Pii app.";

const UNLOCK_TYPES = {
  Unlock: [{ name: "purpose", type: "string" }] as Array<{ name: string; type: string }>,
};

function buildDomain(chainId: number) {
  return { name: "Pii", version: "1", chainId };
}

function buildMessage() {
  return { purpose: UNLOCK_PURPOSE };
}

/** Returned from deriveKeys. */
export interface PiiKeys {
  /** BN254 field element — the raw spending key. Keep secret. */
  sk: bigint;
  /** hash2(sk, 0) — the public identity inside notes. */
  ownerKey: bigint;
}

/**
 * Derives deterministic Pii keys by signing an EIP-712 message.
 *
 * Signs twice and compares; throws if signatures differ (non-deterministic
 * wallet — e.g. some smart-wallet or MPC signers).
 */
export async function deriveKeys(
  signTypedData: SignTypedDataFn,
  chainId: number
): Promise<PiiKeys> {
  const domain = buildDomain(chainId);
  const types = UNLOCK_TYPES;
  const message = buildMessage();
  const args = { domain, types, primaryType: "Unlock" as const, message };

  const sig1 = await signTypedData(args);
  const sig2 = await signTypedData(args);

  checkDeterministic(sig1, sig2);

  return keysFromSignature(sig1);
}

/**
 * Throws a clear error if the two signatures differ, indicating the wallet
 * signs non-deterministically and would cause note loss.
 */
export function checkDeterministic(
  sig1: `0x${string}`,
  sig2: `0x${string}`
): void {
  if (sig1 !== sig2) {
    throw new Error(
      "PiiKeys: wallet produced different signatures for the same message. " +
        "This wallet signs non-deterministically (e.g. some smart-wallet or MPC " +
        "signers). Pii keys MUST be deterministic or notes will be permanently lost. " +
        "Use a standard EOA (MetaMask, Ledger, etc.) instead."
    );
  }
}

/**
 * Derives keys from an already-obtained signature (for testing / offline use).
 */
export function keysFromSignature(sig: `0x${string}`): PiiKeys {
  let sk = BigInt(keccak256(sig)) % BN254_R;
  // Guard against 0 (probability ≈ 1/r, but must handle it)
  if (sk === 0n) sk = 1n;
  const ownerKey = hash2(sk, 0n);
  return { sk, ownerKey };
}
