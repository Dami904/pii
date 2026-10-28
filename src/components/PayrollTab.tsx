/**
 * src/components/PayrollTab.tsx
 * CSV batch private transfers: pii_address,amount per row.
 * Before row 1: ensures N fee notes exist (one per row).
 */

import { useState, useRef, useEffect }           from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { toast }                                  from 'sonner'
import { Upload, Play, AlertCircle, Check, X, Info } from 'lucide-react'
import { usePii }                                 from '../contexts/PiiContext.js'
import { decodePiiAddress }                       from '@sdk/memo'
import { relayTransfer, getRelayerInfo }          from '@sdk/relayer'
import { syncTree }                               from '@sdk/tree'
import { recoverWallet }                          from '@sdk/wallet'
import { prove }                                  from '../lib/worker-bridge.js'
import { prepareTransfer, ensureFeeNotes, FEE_NOTE_AMOUNT } from '../lib/pii-ops.js'
import {
  POOL_ADDRESS, DEPLOY_BLOCK, RELAY_BASE, makePoolContractLike,
  formatUsdc, parseUsdc, makePoolLike,
  USDC_ADDRESS, USDC_ABI,
} from '../lib/pii.js'
import type { PublicClientLike } from '@sdk/tree'
import type { Note } from '@sdk/note'
import type { Hex } from 'viem'

interface CsvRow {
  piiAddress: string
  amount:     bigint
  rawAmount:  string
  error?:     string
}

type RowStatus = 'pending' | 'running' | 'done' | 'failed'

interface RowState {
  row:    CsvRow
  status: RowStatus
  txHash?: string
  error?:  string
}

const RELAYER_FEE = 1000n

export default function PayrollTab() {
  const { address }                        = useAccount()
  const pub                                = usePublicClient()
  const { writeContractAsync }             = useWriteContract()
  const { keys, viewKeys, wallet, setWallet } = usePii()
  const fileRef                            = useRef<HTMLInputElement>(null)

  const [rows, setRows]                = useState<RowState[]>([])
  const [running, setRunning]          = useState(false)
  const [resumeIdx, setResumeIdx]      = useState(0)
  const [relayerAddr, setRelayerAddr]  = useState<Hex | null>(null)
  const [relayerOK, setRelayerOK]      = useState<bigint | null>(null)
  const [feeStatus, setFeeStatus]      = useState<string | null>(null)

  useEffect(() => {
    void getRelayerInfo(RELAY_BASE).then(info => {
      setRelayerAddr(info.relayerAddress)
      setRelayerOK(BigInt(info.relayerOwnerKey))
    }).catch(() => {})
  }, [])

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? ''
      setRows(parseCSV(text).map(r => ({ row: r, status: 'pending' })))
      setResumeIdx(0)
    }
    reader.readAsText(f)
  }

  async function resync(): Promise<Note[]> {
    if (!pub || !keys || !viewKeys) return wallet?.notes ?? []
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

  async function runPayroll() {
    if (!keys || !viewKeys || !wallet || !address) { toast.error('Unlock wallet first'); return }
    if (!relayerAddr || relayerOK === null) { toast.error('Relayer unavailable'); return }
    const validRows = rows.filter(r => !r.row.error && r.status !== 'done')
    if (validRows.length === 0) return
    setRunning(true)

    // ── Pre-flight: ensure enough fee notes ──────────────────────────────────
    let currentNotes = wallet.notes
    const sorted0    = [...currentNotes].sort((a, b) => (b.amount > a.amount ? 1 : -1))
    const inNote0    = sorted0[0]

    const needed = validRows.length
    setFeeStatus(`Checking fee notes (need ${needed})…`)

    try {
      const deposited = await ensureFeeNotes({
        notes:       currentNotes,
        inNote:      inNote0,
        minFee:      RELAYER_FEE,
        needed,
        ownerKey:    keys.ownerKey,
        viewKeys,
        userAddress: address,
        write: async (args) => {
          const hash = await writeContractAsync(args as Parameters<typeof writeContractAsync>[0])
          return hash
        },
        waitReceipt: async (hash) => { await pub!.waitForTransactionReceipt({ hash }) },
        readAllowance: (owner, spender) =>
          pub!.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'allowance', args: [owner, spender] }),
        onProgress: (done, total) => setFeeStatus(`Topping up fee notes: ${done}/${total}…`),
      })
      if (deposited > 0) {
        setFeeStatus(`Deposited ${deposited} fee note(s). Syncing…`)
        currentNotes = await resync()
      }
    } catch (e: unknown) {
      toast.error(`Fee note setup failed: ${e instanceof Error ? e.message : String(e)}`)
      setRunning(false)
      setFeeStatus(null)
      return
    }
    setFeeStatus(null)

    // ── Row-by-row transfers ──────────────────────────────────────────────────
    for (let i = resumeIdx; i < rows.length; i++) {
      const { row } = rows[i]
      if (row.error || rows[i].status === 'done') continue

      setRows(prev => prev.map((r, j) => j === i ? { ...r, status: 'running' } : r))

      try {
        const sortedNow = [...currentNotes].sort((a, b) => (b.amount > a.amount ? 1 : -1))
        const inNote    = sortedNow[0]
        if (!inNote || inNote.amount < row.amount) {
          throw new Error(`Insufficient balance for row ${i + 1}`)
        }
        const feeNote = sortedNow.find(
          n => n.leafIndex !== inNote.leafIndex && n.amount >= RELAYER_FEE
        )
        if (!feeNote) throw new Error(`No fee note available for row ${i + 1}`)

        const recipient = decodePiiAddress(row.piiAddress)

        const prep = prepareTransfer({
          sk:               keys.sk,
          encPub:           viewKeys.encPub,
          inNote,
          feeNote,
          tree:             wallet.syncResult.tree,
          sendAmount:       row.amount,
          fee:              RELAYER_FEE,
          relayerAddr,
          relayerOwnerKey:  relayerOK,
          recipientOwnerKey: recipient.ownerKey,
          recipientEncPub:   recipient.encPub,
          chainId:           BigInt(pub?.chain?.id ?? 5042002),
        })

        const { proof } = await prove('transfer', prep.inputs, () => {})
        prep.relayParams.proof = `0x${Buffer.from(proof).toString('hex')}`

        const result = await relayTransfer(RELAY_BASE, prep.relayParams)
        const txHash = result.status === 'confirmed' ? result.txHash : undefined
        setRows(prev => prev.map((r, j) =>
          j === i ? { ...r, status: 'done', txHash: txHash ? String(txHash) : undefined } : r
        ))
        setResumeIdx(i + 1)

        // Re-sync before next row (change note returns, fee note is spent)
        currentNotes = await resync()
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        setRows(prev => prev.map((r, j) =>
          j === i ? { ...r, status: 'failed', error: msg } : r
        ))
        setResumeIdx(i)
        setRunning(false)
        toast.error(`Row ${i + 1} failed: ${msg}`)
        return
      }
    }
    setRunning(false)
    toast.success('Payroll complete')
  }

  const validRowCount = rows.filter(r => !r.row.error).length
  const total         = rows.reduce((a, r) => a + (r.row.error ? 0n : r.row.amount), 0n)
  const hasErrors     = rows.some(r => r.row.error)
  const pending       = rows.filter(r => r.status === 'pending').length

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      {/* Info blurb */}
      <div className="flex items-start gap-2 rounded-xl bg-[var(--surface-muted)]
                      border border-[var(--border)] px-3 py-2.5">
        <Info className="w-3.5 h-3.5 text-[var(--accent)] mt-0.5 flex-shrink-0" />
        <p className="text-[11px] text-[var(--muted)] leading-relaxed">
          Each private payment uses a small separate fee note (0.02 USDC) so the relayer
          can pay gas without seeing your address. Fee notes are deposited automatically
          before the payroll starts.
        </p>
      </div>

      <div className="rounded-2xl bg-[var(--surface-strong)] border border-[var(--border)]
                      backdrop-blur-sm p-5 flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Payroll
        </p>
        <p className="text-xs text-[var(--muted)]">
          Upload a CSV with columns: <span className="font-mono">pii_address, amount</span>
        </p>

        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFile} />
        <button
          onClick={() => fileRef.current?.click()}
          className="flex items-center justify-center gap-2 h-10 rounded-xl border border-[var(--border)]
                     bg-[var(--surface)] text-sm text-[var(--ink-2)] font-medium
                     hover:bg-[var(--surface-strong)] transition-colors"
        >
          <Upload className="w-4 h-4" />
          {rows.length > 0 ? `${rows.length} rows loaded` : 'Upload CSV'}
        </button>

        {rows.length > 0 && (
          <>
            <div className="flex items-center justify-between text-xs text-[var(--muted)]">
              <span>
                {validRowCount} valid rows
                {validRowCount > 0 && (
                  <span className="ml-1 text-[var(--subtle)]">
                    · needs {validRowCount} fee note{validRowCount !== 1 ? 's' : ''} ({formatUsdc(FEE_NOTE_AMOUNT * BigInt(validRowCount))} USDC)
                  </span>
                )}
              </span>
              <span className="font-semibold tabular-nums">{formatUsdc(total)} USDC total</span>
            </div>

            {hasErrors && (
              <div className="flex items-center gap-2 text-xs text-[var(--danger)]">
                <AlertCircle className="w-3.5 h-3.5" />
                Some rows have errors — fix the CSV before running.
              </div>
            )}

            {feeStatus && (
              <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <div className="w-3 h-3 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                {feeStatus}
              </div>
            )}

            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
              {rows.map((rs, i) => (
                <div key={i} className="flex items-center justify-between rounded-lg
                                        bg-[var(--surface-muted)] px-3 py-2 gap-2">
                  <span className="font-mono text-[10px] text-[var(--subtle)] truncate flex-1">
                    {rs.row.piiAddress.slice(0, 12)}…
                  </span>
                  <span className="text-xs tabular-nums text-[var(--ink-2)] flex-shrink-0">
                    {rs.row.rawAmount}
                  </span>
                  <StatusIcon status={rs.status} errorMsg={rs.row.error ?? rs.error} />
                </div>
              ))}
            </div>

            <button
              onClick={() => { void runPayroll() }}
              disabled={running || hasErrors || !keys || pending === 0}
              className="flex items-center justify-center gap-2 h-12 rounded-xl
                         bg-[var(--accent)] text-white text-sm font-semibold
                         hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              <Play className="w-4 h-4" />
              {running ? (feeStatus ? 'Topping up…' : 'Running…') : resumeIdx > 0 ? 'Resume' : 'Run payroll'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}

function StatusIcon({ status, errorMsg }: { status: RowStatus; errorMsg?: string }) {
  if (status === 'done')    return <Check className="w-3.5 h-3.5 text-[var(--success)] flex-shrink-0" />
  if (status === 'failed')  return (
    <span className="flex items-center gap-1">
      <X className="w-3.5 h-3.5 text-[var(--danger)] flex-shrink-0" />
      {errorMsg && <span className="text-[10px] text-[var(--danger)] truncate max-w-[60px]">{errorMsg}</span>}
    </span>
  )
  if (status === 'running') return <div className="w-3.5 h-3.5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin flex-shrink-0" />
  if (errorMsg)             return <AlertCircle className="w-3.5 h-3.5 text-[var(--danger)] flex-shrink-0" />
  return <div className="w-3.5 h-3.5 rounded-full border border-[var(--border)] flex-shrink-0" />
}

function parseCSV(text: string): CsvRow[] {
  return text.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('pii_address') && !l.startsWith('#'))
    .map(l => {
      const [addr, amt] = l.split(',').map(s => s.trim())
      if (!addr || !amt) return { piiAddress: l, amount: 0n, rawAmount: '', error: 'Bad row' }
      try { decodePiiAddress(addr) }
      catch { return { piiAddress: addr, amount: 0n, rawAmount: amt, error: 'Invalid pii address' } }
      const amount = parseUsdc(amt)
      if (amount <= 0n) return { piiAddress: addr, amount: 0n, rawAmount: amt, error: 'Invalid amount' }
      return { piiAddress: addr, amount, rawAmount: amt }
    })
}
