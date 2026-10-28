/**
 * sdk/src/prover-node.ts
 *
 * Node.js entry point for the prover: loads circuit JSON from the filesystem
 * (relative to this file's location) and delegates to prover-core.ts.
 *
 * Used by scripts and SDK tests. NOT imported by the browser bundle.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledCircuit } from "@noir-lang/types";
import { proveCircuit } from "./prover-core.js";
import type { WithdrawCircuitInputs, TransferCircuitInputs } from "./inputs.js";

export type { ProofResult } from "./prover-core.js";

const __dir = dirname(fileURLToPath(import.meta.url));

const _loaded = new Map<string, CompiledCircuit>();

async function _loadCircuit(name: "withdraw" | "transfer"): Promise<CompiledCircuit> {
  if (_loaded.has(name)) return _loaded.get(name)!;
  const artifactPath = resolve(
    __dir,
    `../../circuits/${name}/target/${name}.json`,
  );
  const raw = await readFile(artifactPath, "utf8");
  const circuit = JSON.parse(raw) as CompiledCircuit;
  _loaded.set(name, circuit);
  return circuit;
}

export async function proveWithdraw(
  inputs: WithdrawCircuitInputs,
): Promise<import("./prover-core.js").ProofResult> {
  const circuit = await _loadCircuit("withdraw");
  return proveCircuit(circuit, inputs as unknown as import("@noir-lang/types").InputMap);
}

export async function proveTransfer(
  inputs: TransferCircuitInputs,
): Promise<import("./prover-core.js").ProofResult> {
  const circuit = await _loadCircuit("transfer");
  return proveCircuit(circuit, inputs as unknown as import("@noir-lang/types").InputMap);
}
