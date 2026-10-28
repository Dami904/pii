/**
 * sdk/src/prover.worker.ts
 *
 * Browser Web Worker wrapper around prover-core.ts.
 * Fetches circuit JSON from /circuits/<name>.json (served as static assets)
 * and caches the compiled circuit so the backend is only initialised once.
 *
 * Messages sent TO the worker:
 *   { type: 'prove', circuit: 'withdraw'|'transfer', inputs: object, id: string }
 *
 * Messages posted FROM the worker:
 *   { type: 'progress', step: 'witness'|'proving'|'done', id: string }
 *   { type: 'result',   proof: Uint8Array, publicInputs: string[], id: string }
 *   { type: 'error',    message: string, id: string }
 */

import { proveWithdrawCircuit, proveTransferCircuit } from "./prover-core.js";
import type { CompiledCircuit } from "@noir-lang/types";
import type { WithdrawCircuitInputs, TransferCircuitInputs } from "./inputs.js";

// ─── Circuit cache ───────────────────────────────────────────────────────────

const _circuits = new Map<string, CompiledCircuit>();

async function loadCircuit(name: "withdraw" | "transfer"): Promise<CompiledCircuit> {
  if (_circuits.has(name)) return _circuits.get(name)!;
  const resp = await fetch(`/circuits/${name}.json`);
  if (!resp.ok) throw new Error(`Failed to fetch circuit ${name}: ${resp.status}`);
  const circuit = (await resp.json()) as CompiledCircuit;
  _circuits.set(name, circuit);
  return circuit;
}

// ─── Message handler ─────────────────────────────────────────────────────────

type ProveMessage = {
  type: "prove";
  circuit: "withdraw" | "transfer";
  inputs: WithdrawCircuitInputs | TransferCircuitInputs;
  id: string;
};

// Web Worker global scope
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (event: MessageEvent<ProveMessage>) => {
  const { type, circuit, inputs, id } = event.data;
  if (type !== "prove") return;

  try {
    self.postMessage({ type: "progress", step: "witness", id });

    const compiledCircuit = await loadCircuit(circuit);

    self.postMessage({ type: "progress", step: "proving", id });

    const result =
      circuit === "withdraw"
        ? await proveWithdrawCircuit(compiledCircuit, inputs as WithdrawCircuitInputs)
        : await proveTransferCircuit(compiledCircuit, inputs as TransferCircuitInputs);

    self.postMessage({ type: "progress", step: "done", id });
    self.postMessage({
      type: "result",
      proof: result.proof,
      publicInputs: result.publicInputs,
      id,
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: String(err instanceof Error ? err.message : err),
      id,
    });
  }
};
