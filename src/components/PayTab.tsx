/**
 * src/components/PayTab.tsx
 */

import { useState, useEffect }                        from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { toast }                                      from 'sonner'
import { Send, Loader, Info }                         from 'lucide-react'
import { usePii }                                     from '../contexts/PiiContext.js'
import {
  POOL_ADDRESS, DEPLOY_BLOCK, RELAY_BASE,
  formatUsdc, parseUsdc, explorerTx, makePoolLike, makePoolContractLike,
  USDC_ADDRESS, USDC_ABI,
} from '../lib/pii.js'
import { prepareTransfer, ensureFeeNotes, FEE_NOTE_AMOUNT } from '../lib/pii-ops.js'
import { prove }                                      from '../lib/worker-bridge.js'
import { syncTree }                                   from '@sdk/tree'
import { recoverWallet }                              from '@sdk/wallet'
import { decodePiiAddress }                           from '@sdk/memo'
import { relayTransfer, getRelayerInfo }              from '@sdk/relayer'
import type { PublicClientLike }                      from '@sdk/tree'
import type { Note }                                  from '@sdk/note'
import type { Hex }                                   from 'viem'

type TxStatus = 'idle' | 'fee-notes' | 'proving' | 'submitting' | 'confirmed' | 'failed' | 'unknown'

const RELAYER_FEE = 1000n

export default function PayTab() {
  const { address }                              = useAccount()
  const pub                                      = usePublicClient()
  const { writeContractAsync }                   = useWriteContract()
  const { keys, viewKeys, wallet, setWallet }    = usePii()

  const [recipient, setRecipient]   = useState('')
  const [amount, setAmount]         = useState('')
  const [stage, setStage]           = useState<string | null>(null)
  const [txStatus, setTxStatus]     = useState<TxStatus>('idle')
  const [txHash, setTxHash]         = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [relayerAddr, setRelayerAddr] = useState<Hex | null>(null)
  const [relayerOK, setRelayerOK]    = useState<bigint | null>(null)
  const [feeProgress, setFeeProgress] = useState<string | null>(null)

  useEffect(() => {
    void getRelayerInfo(RELAY_BASE).then(info => {
      setRelayerAddr(info.relayerAddress)
      setRelayerOK(BigInt(info.relayerOwnerKey))
    }).catch(() => {})
  }, [])

  /** Resync and update wallet state */
  async function resync() {
    if (!pub || !keys || !viewKeys) return
    const pcl   = pub as unknown as PublicClientLike
    const sr    = await syncTree(pcl, makePoolContractLike(pub), POOL_ADDRESS, DEPLOY_BLOCK)
    const pool  = makePoolLike(pub)
    const store = await recoverWallet(
      keys.sk,
      { ownerKey: keys.ownerKey, encPriv: viewKeys.encPriv },
      sr,
      pool,
    )
    const notes = store.unspent()
    setWallet({ syncResult: sr, notes, totalBalance: notes.reduce((a, n) => a + n.amount, 0n) })
    return notes
  }

  async function handlePay() {
    if (!keys || !viewKeys || !pub || !address) { toast.error('Unlock wallet first'); return }
    if (!wallet || wallet.notes.length === 0)   { toast.error('No notes — deposit first'); return }
    if (!relayerAddr || relayerOK === null)      { toast.error('Relayer unavailable'); return }

    const atoms = parseUsdc(amount)
    if (atoms <= 0n) { toast.error('Enter an amount'); return }

    let decoded: ReturnType<typeof decodePiiAddress>
    try { decoded = decodePiiAddress(recipient) }
    catch { toast.error('Invalid Pii address'); return }

    // Pick the largest note as inNote
    const sorted = [...wallet.notes].sort((a, b) => (b.amount > a.amount ? 1 : -1))
    const inNote = sorted[0]
    if (!inNote || inNote.amount < atoms) {
      toast.error(`Need at least ${formatUsdc(atoms)} USDC in a single note`); return
    }

    setError(null)
    setTxHash(null)

    try {
      // ── 1. Ensure a fee note exists ───────────────────────────────────────
      const eligibleFeeNotes = wallet.notes.filter(
        n => n.leafIndex !== inNote.leafIndex && n.amount >= RELAYER_FEE
      )

      let currentNotes: Note[] = wallet.notes
      let currentSR            = wallet.syncResult

      if (eligibleFeeNotes.length === 0) {
        setTxStatus('fee-notes')
        setFeeProgress('Depositing fee note (0/1)…')
        await ensureFeeNotes({
          notes:       wallet.notes,
          inNote,
          minFee:      RELAYER_FEE,
          needed:      1,
          ownerKey:    keys.ownerKey,
          viewKeys,
          userAddress: address,
          write: async (args) => {
            const hash = await writeContractAsync(args as Parameters<typeof writeContractAsync>[0])
            return hash
          },
          waitReceipt: async (hash) => { await pub.waitForTransactionReceipt({ hash }) },
          readAllowance: (owner, spender) =>
            pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'allowance', args: [owner, spender] }),
          onProgress: (done, total) => setFeeProgress(`Depositing fee note (${done}/${total})…`),
        })
        setFeeProgress(null)
        // Re-sync to get the new fee note
        const fresh = await resync()
        if (!fresh) { toast.error('Sync failed after fee deposit'); return }
        currentNotes = fresh
        currentSR    = wallet.syncResult  // updated by resync via setWallet
      }

      // ── 2. Pick feeNote ─────────────────────────────────────────────────
      const updatedInNote = currentNotes.find(n => n.leafIndex === inNote.leafIndex) ?? inNote
      const feeNote = currentNotes.find(
        n => n.leafIndex !== updatedInNote.leafIndex && n.amount >= RELAYER_FEE
      )
      if (!feeNote) {
        toast.error('No fee note found even after deposit — refresh and retry'); return
      }

      // ── 3. Prove + relay ─────────────────────────────────────────────────
      setTxStatus('proving')
      const prep = prepareTransfer({
        sk:               keys.sk,
        encPub:           viewKeys.encPub,
        inNote:           updatedInNote,
        feeNote,
        tree:             currentSR.tree,
        sendAmount:       atoms,
        fee:              RELAYER_FEE,
        relayerAddr,
        relayerOwnerKey:  relayerOK,
        recipientOwnerKey: decoded.ownerKey,
        recipientEncPub:   decoded.encPub,
        chainId:           BigInt(pub.chain?.id ?? 5042002),
      })

      const { proof } = await prove('transfer', prep.inputs, (s) => setStage(s))

      setTxStatus('submitting')
      prep.relayParams.proof = `0x${Buffer.from(proof).toString('hex')}`

      const relayResult = await relayTransfer(RELAY_BASE, prep.relayParams)

      if (relayResult.status === 'confirmed' && relayResult.txHash) {
        setTxHash(relayResult.txHash)
        setTxStatus('confirmed')
        await resync()
        setAmount('')
        setRecipient('')
      } else if (relayResult.status === 'unknown') {
        setTxStatus('unknown')
      } else {
        setTxStatus('failed')
        setError('Transfer not confirmed.')
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setTxStatus('failed')
    } finally {
      setStage(null)
      setFeeProgress(null)
    }
  }

  const busy = txStatus === 'fee-notes' || txStatus === 'proving' || txStatus === 'submitting'

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      {/* Info blurb */}
      <div className="flex items-start gap-2 rounded-xl bg-[var(--surface-muted)]
                      border border-[var(--border)] px-3 py-2.5">
        <Info className="w-3.5 h-3.5 text-[var(--accent)] mt-0.5 flex-shrink-0" />
        <p className="text-[11px] text-[var(--muted)] leading-relaxed">
          Each private payment uses a small separate fee note (0.02 USDC) so the relayer
          can pay gas without seeing your address. One will be deposited automatically if needed.
        </p>
      </div>

      <div className="rounded-2xl bg-[var(--surface-strong)] border border-[var(--border)]
                      backdrop-blur-sm p-5 flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">Pay</p>

        <div className="flex flex-col gap-3">
          <input
            placeholder="pii:… recipient"
            value={recipient}
            onChange={e => setRecipient(e.target.value)}
            className="h-11 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)]
                       px-4 text-sm font-mono text-[var(--ink)] outline-none
                       focus:border-[var(--focus)] transition-colors"
          />
          <div className="flex items-center gap-2 rounded-xl border border-[var(--border)]
                          bg-[var(--surface-muted)] px-4 h-14">
            <input
              type="number" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)}
              className="flex-1 bg-transparent text-xl font-display font-600 text-[var(--ink)]
                         outline-none tabular-nums [appearance:textfield]"
            />
            <span className="text-sm font-semibold text-[var(--muted)]">USDC</span>
          </div>
        </div>

        {/* Fee note info */}
        {wallet && (() => {
          const atoms = parseUsdc(amount || '0')
          const inN   = [...wallet.notes].sort((a, b) => (b.amount > a.amount ? 1 : -1))[0]
          const hasFee = wallet.notes.some(n => n.leafIndex !== inN?.leafIndex && n.amount >= RELAYER_FEE)
          if (!hasFee && atoms > 0n) return (
            <p className="text-[11px] text-[var(--muted)] px-1">
              No fee note detected — one {formatUsdc(FEE_NOTE_AMOUNT)} USDC fee note will be
              deposited before sending.
            </p>
          )
          return null
        })()}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <Loader className="w-3.5 h-3.5 animate-spin" />
            {txStatus === 'fee-notes'   ? (feeProgress ?? 'Preparing fee note…')
              : txStatus === 'proving'  ? `Proving: ${stage ?? '…'}`
              : 'Sending to relayer…'}
          </div>
        )}

        {txStatus === 'confirmed' && txHash && (
          <div className="rounded-xl bg-[var(--surface-muted)] p-3 flex flex-col gap-1">
            <p className="text-xs font-semibold text-[var(--success)]">Transfer confirmed</p>
            <a href={explorerTx(txHash)} target="_blank" rel="noopener noreferrer"
               className="text-xs font-mono text-[var(--accent)] break-all hover:underline">
              {txHash}
            </a>
          </div>
        )}
        {txStatus === 'unknown' && (
          <p className="text-xs text-[var(--muted)]">Status unknown — checking on-chain…</p>
        )}
        {txStatus === 'failed' && error && (
          <p className="text-xs text-[var(--danger)]">{error}</p>
        )}

        <button
          onClick={() => { void handlePay() }}
          disabled={busy || !keys || !amount || !recipient || !relayerAddr}
          className="flex items-center justify-center gap-2 h-12 rounded-xl
                     bg-[var(--accent)] text-white text-sm font-semibold
                     hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          <Send className="w-4 h-4" />
          {busy ? (txStatus === 'fee-notes' ? 'Topping up…' : 'Proving…') : 'Send privately'}
        </button>
      </div>
    </div>
  )
}
