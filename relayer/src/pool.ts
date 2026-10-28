/**
 * relayer/src/pool.ts
 * Minimal ABI and contract-read helpers for PiiPool.
 */

import { getContract } from "viem";
import { publicClient, walletClient, POOL_ADDRESS } from "./config.js";

export const POOL_ABI = [
  {
    name: "nullifierSpent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "isKnownRoot",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      { name: "root", type: "uint256" },
      { name: "nullifier", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "changeCommitment", type: "uint256" },
      { name: "relayer", type: "address" },
      { name: "fee", type: "uint256" },
      { name: "memos", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proof", type: "bytes" },
      {
        name: "a",
        type: "tuple",
        components: [
          { name: "root", type: "uint256" },
          { name: "nf0", type: "uint256" },
          { name: "nf1", type: "uint256" },
          { name: "nfFee", type: "uint256" },
          { name: "outRecipient", type: "uint256" },
          { name: "outChange", type: "uint256" },
          { name: "outFee", type: "uint256" },
          { name: "outFeeChange", type: "uint256" },
          { name: "eligibilityRoot", type: "uint256" },
          { name: "fee", type: "uint256" },
          { name: "relayerOwnerKey", type: "uint256" },
        ],
      },
      { name: "relayer", type: "address" },
      { name: "memos", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

export const pool = getContract({
  address: POOL_ADDRESS,
  abi: POOL_ABI,
  client: { public: publicClient, wallet: walletClient },
});

export async function isNullifierSpent(nf: bigint): Promise<boolean> {
  return pool.read.nullifierSpent([nf]);
}
