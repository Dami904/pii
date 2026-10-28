/**
 * relayer/src/validate.ts
 * Ordered validation for withdraw and transfer relay requests.
 * Returns null on success or an error object {status, message}.
 */

import type { Hex } from "viem";
import { account, POOL_ADDRESS, MIN_FEE, relayerSpendingKey } from "./config.js";
import { isNullifierSpent } from "./pool.js";
import { publicClient, chain } from "./config.js";
import { POOL_ABI } from "./pool.js";
import { hash2 } from "../../sdk/src/hash.js";

export const RELAYER_OWNER_KEY: bigint = hash2(relayerSpendingKey, 0n);
export const MEMO_LENGTH = 134;
export const WITHDRAW_MEMO_COUNT = 1;
export const TRANSFER_MEMO_COUNT = 4;

export interface RelayError {
  status: number;
  message: string;
}

function err(status: number, message: string): RelayError {
  return { status, message };
}

// ── Withdraw request shape ─────────────────────────────────────────────────

export interface WithdrawRequest {
  proof: Hex;
  root: string;
  nullifier: string;
  recipient: Hex;
  amount: string;
  changeCommitment: string;
  relayer: Hex;
  fee: string;
  memos: Hex[];
  chainId: number;
  pool: Hex;
}

export async function validateWithdraw(
  req: WithdrawRequest,
): Promise<RelayError | null> {
  // a. chain + pool
  if (req.chainId !== chain.id)
    return err(400, `chainId mismatch: expected ${chain.id}`);
  if (req.pool.toLowerCase() !== POOL_ADDRESS.toLowerCase())
    return err(400, "pool address mismatch");

  // b. memo count + length
  if (req.memos.length !== WITHDRAW_MEMO_COUNT)
    return err(400, `withdraw requires exactly ${WITHDRAW_MEMO_COUNT} memo`);
  for (const m of req.memos) {
    const bytes = Buffer.from(m.slice(2), "hex");
    if (bytes.length !== MEMO_LENGTH)
      return err(400, `memo must be ${MEMO_LENGTH} bytes`);
  }

  // c. relayer address + fee
  if (req.relayer.toLowerCase() !== account.address.toLowerCase())
    return err(400, "relayer address mismatch");
  const fee = BigInt(req.fee);
  if (fee < MIN_FEE) return err(400, `fee too low: min ${MIN_FEE}`);

  // d. nullifier not spent
  const nf = BigInt(req.nullifier);
  if (await isNullifierSpent(nf))
    return err(409, "nullifier already spent");

  // e. eth_call simulation
  try {
    await publicClient.simulateContract({
      address: POOL_ADDRESS,
      abi: POOL_ABI,
      functionName: "withdraw",
      args: [
        req.proof,
        BigInt(req.root),
        nf,
        req.recipient,
        BigInt(req.amount),
        BigInt(req.changeCommitment),
        req.relayer,
        fee,
        req.memos,
      ],
      account: account.address,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(422, `simulation failed: ${msg}`);
  }

  return null;
}

// ── Transfer request shape ─────────────────────────────────────────────────

export interface TransferRequest {
  proof: Hex;
  args: {
    root: string;
    nf0: string;
    nf1: string;
    nfFee: string;
    outRecipient: string;
    outChange: string;
    outFee: string;
    outFeeChange: string;
    eligibilityRoot: string;
    fee: string;
    relayerOwnerKey: string;
  };
  relayer: Hex;
  memos: Hex[];
  chainId: number;
  pool: Hex;
}

export async function validateTransfer(
  req: TransferRequest,
): Promise<RelayError | null> {
  // a. chain + pool
  if (req.chainId !== chain.id)
    return err(400, `chainId mismatch: expected ${chain.id}`);
  if (req.pool.toLowerCase() !== POOL_ADDRESS.toLowerCase())
    return err(400, "pool address mismatch");

  // b. memo count + length
  if (req.memos.length !== TRANSFER_MEMO_COUNT)
    return err(400, `transfer requires exactly ${TRANSFER_MEMO_COUNT} memos`);
  for (const m of req.memos) {
    const bytes = Buffer.from(m.slice(2), "hex");
    if (bytes.length !== MEMO_LENGTH)
      return err(400, `memo must be ${MEMO_LENGTH} bytes`);
  }

  // c. relayer address, relayerOwnerKey, fee
  if (req.relayer.toLowerCase() !== account.address.toLowerCase())
    return err(400, "relayer address mismatch");
  if (BigInt(req.args.relayerOwnerKey) !== RELAYER_OWNER_KEY)
    return err(400, "relayerOwnerKey mismatch");
  const fee = BigInt(req.args.fee);
  if (fee < MIN_FEE) return err(400, `fee too low: min ${MIN_FEE}`);

  // d. nullifiers not spent
  for (const nfStr of [req.args.nf0, req.args.nf1, req.args.nfFee]) {
    const nf = BigInt(nfStr);
    if (nf !== 0n && (await isNullifierSpent(nf)))
      return err(409, "nullifier already spent");
  }

  // e. eth_call simulation
  try {
    await publicClient.simulateContract({
      address: POOL_ADDRESS,
      abi: POOL_ABI,
      functionName: "transfer",
      args: [
        req.proof,
        {
          root: BigInt(req.args.root),
          nf0: BigInt(req.args.nf0),
          nf1: BigInt(req.args.nf1),
          nfFee: BigInt(req.args.nfFee),
          outRecipient: BigInt(req.args.outRecipient),
          outChange: BigInt(req.args.outChange),
          outFee: BigInt(req.args.outFee),
          outFeeChange: BigInt(req.args.outFeeChange),
          eligibilityRoot: BigInt(req.args.eligibilityRoot),
          fee: BigInt(req.args.fee),
          relayerOwnerKey: BigInt(req.args.relayerOwnerKey),
        },
        req.relayer,
        req.memos,
      ],
      account: account.address,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(422, `simulation failed: ${msg}`);
  }

  return null;
}
