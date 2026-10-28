/**
 * src/lib/pii-ops.ts
 * High-level wrappers that build circuit inputs, relay params, and manage fee notes.
 */

import { encryptMemo, dummyMemo }             from '@sdk/memo'
import { buildTransferInputs, buildWithdrawInputs } from '@sdk/inputs'
import { depositSecret }                       from '@sdk/note'
import type { Note }                           from '@sdk/note'
import type { MerkleTree, SyncResult }         from '@sdk/tree'
import type { TransferRelayParams, WithdrawRelayParams } from '@sdk/relayer'
import type { TransferCircuitInputs, WithdrawCircuitInputs } from '@sdk/inputs'
import type { ViewingKeys }                    from '@sdk/memo'
import { POOL_ADDRESS, USDC_ADDRESS, POOL_ABI, USDC_ABI } from './pii.js'
import type { Hex }                            from 'viem'

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * USDC_ID = hash2(uint160(USDC_ADDR), 0) — from the golden vectors.
 * Must match PiiPool.USDC_ID on-chain.
 */
export const USDC_ID = BigInt('0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86e')

/**
 * Each private transfer spends one "fee note" for the relayer.
 * 0.02 USDC = 20_000 atoms — enough for multiple relayed tx gas costs.
 */
export const FEE_NOTE_AMOUNT = 20_000n  // 0.02 USDC

// ── Types ────────────────────────────────────────────────────────────────────

export interface TransferPrep {
  circuit: 'transfer'
  inputs: TransferCircuitInputs
  relayParams: TransferRelayParams
}

export interface WithdrawPrep {
  circuit: 'withdraw'
  inputs: WithdrawCircuitInputs
  relayParams: WithdrawRelayParams
}

/** Minimal write-contract callable by the fee-note depositor */
export type WriteContractFn = (args: {
  address: Hex
  abi: typeof POOL_ABI | typeof USDC_ABI
  functionName: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: readonly any[]
  gas?: bigint
}) => Promise<Hex>

/** Wait-for-receipt callable by the fee-note depositor */
export type WaitForReceiptFn = (hash: Hex) => Promise<void>

// ── Internal helpers ─────────────────────────────────────────────────────────

function randBlinding(): bigint {
  return BigInt(Date.now()) * 1_000_003n + BigInt(Math.floor(Math.random() * 1e9))
}

function hex64(n: bigint): `0x${string}` {
  return `0x${n.toString(16).padStart(64, '0')}`
}

// ── Fee note management ───────────────────────────────────────────────────────

/**
 * Deposit one fee note (FEE_NOTE_AMOUNT) into the pool, encrypted to self.
 * Approves only the exact amount needed (re-checks allowance first).
 * Returns the deposit tx hash.
 */
export async function depositFeeNote(
  ownerKey:    bigint,
  viewKeys:    ViewingKeys,
  userAddress: Hex,
  write:       WriteContractFn,
  waitReceipt: WaitForReceiptFn,
  readAllowance: (owner: Hex, spender: Hex) => Promise<bigint>,
): Promise<Hex> {
  // Approve if needed
  const allowance = await readAllowance(userAddress, POOL_ADDRESS)
  if (allowance < FEE_NOTE_AMOUNT) {
    const approveTx = await write({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: 'approve',
      args: [POOL_ADDRESS, FEE_NOTE_AMOUNT],
    })
    await waitReceipt(approveTx)
  }

  const blinding = randBlinding()
  const secret   = depositSecret(ownerKey, blinding)
  const memo     = encryptMemo(viewKeys.encPub, { assetId: USDC_ID, amount: FEE_NOTE_AMOUNT, blinding })

  const depositTx = await write({
    address: POOL_ADDRESS,
    abi: POOL_ABI,
    functionName: 'deposit',
    args: [FEE_NOTE_AMOUNT, secret, memo],
    gas: 900_000n,
  })
  await waitReceipt(depositTx)
  return depositTx
}

/**
 * Count unspent fee-eligible notes (amount >= minFee, not the chosen inNote).
 * If count < needed, deposit more fee notes one at a time.
 *
 * Returns the number of fee notes deposited (0 if already sufficient).
 * Each deposit triggers onProgress(deposited, needed) so the UI can show progress.
 */
export async function ensureFeeNotes(opts: {
  notes:         Note[]
  inNote:        Note
  minFee:        bigint
  needed:        number
  ownerKey:      bigint
  viewKeys:      ViewingKeys
  userAddress:   Hex
  write:         WriteContractFn
  waitReceipt:   WaitForReceiptFn
  readAllowance: (owner: Hex, spender: Hex) => Promise<bigint>
  onProgress?:   (deposited: number, total: number) => void
}): Promise<number> {
  const {
    notes, inNote, minFee, needed,
    ownerKey, viewKeys, userAddress, write, waitReceipt, readAllowance, onProgress,
  } = opts

  const eligible = notes.filter(n => n.leafIndex !== inNote.leafIndex && n.amount >= minFee)
  const missing  = needed - eligible.length
  if (missing <= 0) return 0

  for (let i = 0; i < missing; i++) {
    onProgress?.(i, missing)
    await depositFeeNote(ownerKey, viewKeys, userAddress, write, waitReceipt, readAllowance)
  }
  onProgress?.(missing, missing)
  return missing
}

// ── Transfer preparation ─────────────────────────────────────────────────────

/**
 * Prepare a transfer: build circuit inputs and relay params.
 * The returned `relayParams.proof` is '0x' — fill it after proving.
 * Requires a distinct feeNote (different leafIndex from inNote).
 */
export function prepareTransfer(opts: {
  sk:               bigint
  encPub:           Uint8Array
  inNote:           Note
  feeNote:          Note      // required: must be a distinct note
  tree:             MerkleTree
  sendAmount:       bigint
  fee:              bigint
  relayerAddr:      Hex
  relayerOwnerKey:  bigint
  recipientOwnerKey: bigint
  recipientEncPub:  Uint8Array
  chainId:          bigint
}): TransferPrep {
  const {
    sk, encPub, inNote, feeNote, tree,
    sendAmount, fee, relayerAddr, relayerOwnerKey,
    recipientOwnerKey, recipientEncPub, chainId,
  } = opts

  const assetId           = inNote.assetId
  const recipientBlinding = randBlinding()
  const changeBlinding    = randBlinding()
  const feeOutBlinding    = randBlinding()
  const feeChangeBlinding = randBlinding()

  const change    = inNote.amount - sendAmount
  const feeChange = feeNote.amount - fee

  const memoRecipient = encryptMemo(recipientEncPub, { assetId, amount: sendAmount, blinding: recipientBlinding })
  const memoChange    = change > 0n
    ? encryptMemo(encPub, { assetId, amount: change,     blinding: changeBlinding })
    : dummyMemo()
  const memoFeeOut    = encryptMemo(encPub, { assetId, amount: fee,       blinding: feeOutBlinding })
  const memoFeeChange = feeChange > 0n
    ? encryptMemo(encPub, { assetId, amount: feeChange,  blinding: feeChangeBlinding })
    : dummyMemo()

  const memos = [memoRecipient, memoChange, memoFeeOut, memoFeeChange] as [
    `0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`
  ]

  const { inputs, publicInputs } = buildTransferInputs({
    sk,
    inNotes:          [inNote],
    feeNote,
    leafIndices:      [inNote.leafIndex!, feeNote.leafIndex!],
    tree,
    recipientOwnerKey,
    sendAmount,
    fee,
    relayerOwnerKey,
    relayer:          relayerAddr,
    memos,
    pool:             POOL_ADDRESS,
    chainId,
    blindings: { recipientBlinding, changeBlinding, feeOutBlinding, feeChangeBlinding },
  })

  const relayParams: TransferRelayParams = {
    proof: '0x',
    args: {
      root:            hex64(publicInputs[0]),
      nf0:             hex64(publicInputs[1]),
      nf1:             hex64(publicInputs[2]),
      nfFee:           hex64(publicInputs[3]),
      outRecipient:    hex64(publicInputs[4]),
      outChange:       hex64(publicInputs[5]),
      outFee:          hex64(publicInputs[6]),
      outFeeChange:    hex64(publicInputs[7]),
      eligibilityRoot: hex64(publicInputs[8]),
      fee:             hex64(publicInputs[9]),
      relayerOwnerKey: hex64(publicInputs[10]),
    },
    relayer: relayerAddr,
    memos,
    chainId: Number(chainId),
    pool:    POOL_ADDRESS,
  }

  return { circuit: 'transfer', inputs, relayParams }
}

// ── Withdraw preparation ──────────────────────────────────────────────────────

/**
 * Prepare a withdrawal: build circuit inputs and relay params.
 * The returned `relayParams.proof` is '0x' — fill it after proving.
 * Withdraw takes the fee from the same note — no separate fee note needed.
 */
export function prepareWithdraw(opts: {
  sk:            bigint
  note:          Note
  tree:          MerkleTree | SyncResult
  amount:        bigint
  fee:           bigint
  relayerAddr:   Hex
  recipient:     Hex
  chainId:       bigint
}): WithdrawPrep {
  const { sk, note, tree, amount, fee, relayerAddr, recipient, chainId } = opts

  // Accept SyncResult or bare MerkleTree
  const merkleTree = 'tree' in tree ? tree.tree : tree

  const changeBlinding = randBlinding()
  const changeMemo     = dummyMemo()

  const { inputs, publicInputs } = buildWithdrawInputs({
    sk,
    note,
    tree:       merkleTree,
    leafIndex:  note.leafIndex!,
    recipient,
    amount,
    relayer:    relayerAddr,
    fee,
    memos:      [changeMemo],
    pool:       POOL_ADDRESS,
    chainId,
    changeBlinding,
  })

  // publicInputs order (matches withdraw circuit): [root, nullifier, recipient, net, changeCommitment, extDataHash]
  // fee is not a circuit public input — pass it from opts directly
  const relayParams: WithdrawRelayParams = {
    proof:            '0x',
    root:             hex64(publicInputs[0]),
    nullifier:        hex64(publicInputs[1]),
    recipient,
    amount:           hex64(publicInputs[3]),   // net (= amount − fee)
    changeCommitment: hex64(publicInputs[4]),
    relayer:          relayerAddr,
    fee:              hex64(fee),
    memos:            [changeMemo],
    chainId:          Number(chainId),
    pool:             POOL_ADDRESS,
  }

  return { circuit: 'withdraw', inputs, relayParams }
}
