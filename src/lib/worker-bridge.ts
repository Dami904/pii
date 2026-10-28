/**
 * src/lib/worker-bridge.ts
 * Typed bridge to sdk/src/prover.worker.ts running inside a Web Worker.
 *
 * Worker protocol (from prover.worker.ts):
 *   IN:  { type: "prove", circuit: "withdraw"|"transfer", inputs: object, id: string }
 *   OUT: { type: "progress", step: "witness"|"proving"|"done", id: string }
 *        { type: "result",   proof: Uint8Array, publicInputs: string[], id: string }
 *        { type: "error",    message: string, id: string }
 */

import type { WithdrawCircuitInputs, TransferCircuitInputs } from '@sdk/inputs'

export type ProveStage = 'witness' | 'proving' | 'done'

let _worker: Worker | null = null
let _idCounter = 0

function getWorker(): Worker {
  if (!_worker) {
    _worker = new Worker(
      new URL('../../sdk/src/prover.worker.ts', import.meta.url),
      { type: 'module' }
    )
  }
  return _worker
}

export function prove(
  circuit: 'withdraw' | 'transfer',
  inputs: WithdrawCircuitInputs | TransferCircuitInputs,
  onProgress: (stage: ProveStage) => void,
): Promise<{ proof: Uint8Array; publicInputs: string[] }> {
  return new Promise((resolve, reject) => {
    const id = String(++_idCounter)
    const w  = getWorker()
    const handler = (ev: MessageEvent) => {
      // Only handle messages for our id
      const msg = ev.data as { type: string; step?: string; proof?: Uint8Array; publicInputs?: string[]; message?: string; id: string }
      if (msg.id !== id) return
      if (msg.type === 'progress') {
        onProgress(msg.step as ProveStage)
        return
      }
      w.removeEventListener('message', handler)
      if (msg.type === 'result') {
        resolve({ proof: msg.proof!, publicInputs: msg.publicInputs! })
      } else {
        reject(new Error(msg.message ?? 'Prove failed'))
      }
    }
    w.addEventListener('message', handler)
    w.postMessage({ type: 'prove', circuit, inputs, id })
  })
}
