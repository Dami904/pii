/**
 * sdk/src/prover.ts
 *
 * Backwards-compatible re-export shim for Node.js scripts and SDK tests.
 * Delegates to prover-node.ts which loads circuit JSON via node:fs.
 *
 * NOT imported by the browser bundle — the browser uses prover-core.ts via
 * the Web Worker (sdk/src/prover.worker.ts).
 */

export { proveWithdraw, proveTransfer } from "./prover-node.js";
export type { ProofResult } from "./prover-core.js";
