/**
 * sdk/src/prover-core.ts
 *
 * Platform-neutral UltraHonk prover for withdraw and transfer circuits.
 * Accepts a pre-loaded CompiledCircuit so this file has zero Node.js imports
 * and can be bundled into a browser Web Worker via Vite.
 *
 * Version notes:
 *   @noir-lang/noir_js  1.0.0-rc.5  — matches nargo 1.0.0-rc.5
 *   @aztec/bb.js        5.2.1       — matches bb 5.2.1 (pinned toolchain)
 */

import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import type { CompiledCircuit } from "@noir-lang/types";
import type { InputMap } from "@noir-lang/types";
import type { WithdrawCircuitInputs, TransferCircuitInputs } from "./inputs.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProofResult = {
  /** Raw ZK proof bytes (no public inputs prepended) */
  proof: Uint8Array;
  /** Public inputs as 0x-prefixed hex strings (one per 32-byte field). */
  publicInputs: `0x${string}`[];
};

// ─── Backend cache (keyed by circuit bytecode identity) ─────────────────────

type BackendEntry = { noir: Noir; backend: UltraHonkBackend };
const _cache = new Map<string, BackendEntry>();

async function _getOrCreate(circuit: CompiledCircuit): Promise<BackendEntry> {
  const key = circuit.bytecode.slice(0, 64); // first 64 chars is a stable identity
  if (_cache.has(key)) return _cache.get(key)!;

  const api = await Barretenberg.new();
  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const noir = new Noir(circuit);
  await noir.init();

  const entry: BackendEntry = { noir, backend };
  _cache.set(key, entry);
  return entry;
}

// ─── Core prove ─────────────────────────────────────────────────────────────

export async function proveCircuit(
  circuit: CompiledCircuit,
  inputs: InputMap,
): Promise<ProofResult> {
  const { noir, backend } = await _getOrCreate(circuit);

  const { witness } = await noir.execute(inputs);
  const proofData = await backend.generateProof(witness, {
    verifierTarget: "evm",
  });

  const pubs = proofData.publicInputs.map((s) => {
    const padded = s.startsWith("0x") ? s : `0x${s}`;
    return padded as `0x${string}`;
  });

  return { proof: proofData.proof, publicInputs: pubs };
}

// ─── Named helpers (circuit passed in, no filesystem) ───────────────────────

export async function proveWithdrawCircuit(
  circuit: CompiledCircuit,
  inputs: WithdrawCircuitInputs,
): Promise<ProofResult> {
  return proveCircuit(circuit, inputs as unknown as InputMap);
}

export async function proveTransferCircuit(
  circuit: CompiledCircuit,
  inputs: TransferCircuitInputs,
): Promise<ProofResult> {
  return proveCircuit(circuit, inputs as unknown as InputMap);
}
