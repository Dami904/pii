/**
 * sdk/src/index.ts
 * Public API re-exports for the Pii SDK.
 */

export { ARC_TESTNET, LOCAL_ANVIL } from "./config.js";
export { BN254_R, ZERO_VALUE, hash2, hash3 } from "./hash.js";
export {
  deriveKeys,
  keysFromSignature,
  checkDeterministic,
} from "./keys.js";
export type { PiiKeys, SignTypedDataFn } from "./keys.js";
export {
  commitment,
  nullifier,
  depositSecret,
  randomBlinding,
} from "./note.js";
export type { Note } from "./note.js";
export {
  buildTree,
  computeZeros,
  syncTree,
  leavesWithMemos,
  DEPTH,
  EMPTY_TREE_ROOT,
} from "./tree.js";
export type {
  MerkleTree,
  SyncResult,
  PublicClientLike,
  PoolContractLike,
} from "./tree.js";
export { NoteStore, MemoryStorage, recoverWallet } from "./wallet.js";
export type { NoteStorage, PoolReadLike, RecoverViewingKeys } from "./wallet.js";
export { submitAndTrack } from "./tx.js";
export type { TxOutcome, PublicClientForTx, PoolNullifierReader } from "./tx.js";
export { extDataHash, buildWithdrawInputs, buildTransferInputs } from "./inputs.js";
export type {
  WithdrawCircuitInputs,
  TransferCircuitInputs,
  WithdrawBuildResult,
  TransferBuildResult,
  WithdrawParams,
  TransferParams,
} from "./inputs.js";
export { proveWithdraw, proveTransfer } from "./prover.js";
export type { ProofResult } from "./prover.js";
export {
  deriveViewingKeys,
  encodePiiAddress,
  decodePiiAddress,
  encryptMemo,
  tryDecryptMemo,
  buildMemo,
  dummyMemo,
  scanNotes,
  MEMO_BYTE_LENGTH,
} from "./memo.js";
export type { ViewingKeys, MemoPayload, LeafWithMemo } from "./memo.js";
export {
  getRelayerInfo,
  relayWithdraw,
  relayTransfer,
  waitForStatus,
  selfRelay,
} from "./relayer.js";
export type {
  RelayerInfo,
  RelayResult,
  WithdrawRelayParams,
  TransferRelayParams,
  SelfRelayWallet,
} from "./relayer.js";
