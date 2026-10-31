/**
 * src/components/PayrollTab.tsx
 * CSV batch private transfers: pii_address,amount per row.
 * Before row 1: ensures N fee notes exist (one per row).
 */

import { useState, useRef, useEffect }           from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { toast }                                  from 'sonner'
import { Upload, Download, Play, AlertCircle, Check, X, Info } from 'lucide-react'
import { usePii }                                 from '../contexts/PiiContext.js'
import { decodePiiAddress, encodePiiAddress }    from '@sdk/memo'
import { relayTransfer, getRelayerInfo, type RelayerInfo } from '@sdk/relayer'
import { relayerCapacity }                        from '../lib/relayer-gas.js'
import { syncPool }         from '../lib/sync.js'
import { recoverWallet }                          from '@sdk/wallet'
import { prove }                                  from '../lib/worker-bridge.js'
import { addActivity }                            from '../lib/activity.js'
import { planPayment }                            from '../lib/pay-plan.js'
import { NETWORK }                                from '../lib/network.js'
import { parseCSV, buildSampleCsv, type CsvRow }   from '../lib/payroll-csv.js'
import { sendInParts }                            from '../lib/pay-parts.js'
import { ensureFeeNotes, FEE_NOTE_AMOUNT } from '../lib/pii-ops.js'
import {
  RELAY_BASE, 
  formatUsdc, makePoolLike,
  USDC_ADDRESS, USDC_ABI, CHAIN_ID,
} from '../lib/pii.js'
import type { SyncResult } from '@sdk/tree'
import type { Note } from '@sdk/note'
import type { Hex } from 'viem'

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
  const { keys, viewKeys, wallet, setWallet, startTask } = usePii()
  const fileRef                            = useRef<HTMLInputElement>(null)

  const [rows, setRows]                = useState<RowState[]>([])
  const [running, setRunning]          = useState(false)
  const [resumeIdx, setResumeIdx]      = useState(0)
  const [relayerAddr, setRelayerAddr]  = useState<Hex | null>(null)
  const [relayerOK, setRelayerOK]      = useState<bigint | null>(null)
  const [feeStatus, setFeeStatus]      = useState<string | null>(null)
  const [relayerInfo, setRelayerInfo] = useState<RelayerInfo | null>(null)

  useEffect(() => {
    void getRelayerInfo(RELAY_BASE).then(info => {
      setRelayerAddr(info.relayerAddress)
      setRelayerOK(BigInt(info.relayerOwnerKey))
      setRelayerInfo(info)
    }).catch(() => {})
  }, [])

  // A relayer minimum fee of 0 means payments take no fee and need no fee note.
  const noFee    = relayerInfo !== null && BigInt(relayerInfo.minFee) === 0n
  const feeAtoms = noFee ? 0n : RELAYER_FEE
  const capacity = relayerCapacity(relayerInfo, noFee)

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) ?? ''
      setRows(parseCSV(text, NETWORK).map(r => ({ row: r, status: 'pending' })))
      setResumeIdx(0)
    }
    reader.readAsText(f)
  }

  /**
   * Resync and update wallet state. Returns the fresh tree too: setWallet does not
   * update `wallet` inside the running payroll loop, so each row must prove against `sr`.
   */
  async function resync(minLeaves = 0): Promise<{ notes: Note[]; sr: SyncResult } | null> {
    if (!pub || !keys || !viewKeys) return null
    const sr    = await syncPool(pub, minLeaves)
    const pool  = makePoolLike(pub)
    const store = await recoverWallet(
      keys.sk,
      { ownerKey: keys.ownerKey, encPriv: viewKeys.encPriv },
      sr,
      pool,
    )
    const notes = store.unspent()
    setWallet({ syncResult: sr, notes, totalBalance: notes.reduce((a, n) => a + n.amount, 0n) })
    return { notes, sr }
  }

  /** A starter file whose example rows use the user's own Pii address, so it works as a test. */
  function downloadSample() {
    if (!keys || !viewKeys) return
    const csv = buildSampleCsv(encodePiiAddress(keys.ownerKey, viewKeys.encPub, NETWORK))
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'pii-payroll-sample.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Locks tab navigation while this runs, so a payment cannot be started twice or orphaned. */
  async function runPayroll() {
    const end = startTask('Payroll')
    try { await payrollInner() } finally { end() }
  }

  async function payrollInner() {
    if (!keys || !viewKeys || !wallet || !address) { toast.error('Unlock wallet first'); return }
    if (!relayerAddr || relayerOK === null) { toast.error('Relayer unavailable'); return }
    const validRows = rows.filter(r => !r.row.error && r.status !== 'done')
    if (validRows.length === 0) return
    // Refuse up front if the relayer cannot cover every row, instead of dying half-way.
    if (capacity && capacity.transfersLeft < validRows.length) {
      toast.error(`The relayer is low on gas: about ${capacity.transfersLeft} payments left, this payroll needs ${validRows.length}. Please try again later.`)
      return
    }
    setRunning(true)

    // Start (or resume) from a fresh sync, never from possibly stale wallet state.
    const start = await resync().catch(() => null)
    if (!start) { toast.error('Sync failed. Try again.'); setRunning(false); return }
    let currentNotes = start.notes
    let currentSR    = start.sr

    // A fee note is a note other than the ones a row spends. Deposit one if none is left.
    // One is enough: each row returns its fee change as a new note, which pays the next fee.
    async function topUpFee(inputs: Note[], notes: Note[], sr: SyncResult): Promise<{ notes: Note[]; sr: SyncResult }> {
      const deposited = await ensureFeeNotes({
        notes,
        inNote:      inputs[0],
        inNote2:     inputs[1],
        minFee:      RELAYER_FEE,
        needed:      1,
        ownerKey:    keys!.ownerKey,
        viewKeys:    viewKeys!,
        userAddress: address!,
        write: async (args) => {
          const hash = await writeContractAsync(args as Parameters<typeof writeContractAsync>[0])
          return hash
        },
        waitReceipt: async (hash) => { await pub!.waitForTransactionReceipt({ hash }) },
        readAllowance: (owner, spender) =>
          pub!.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'allowance', args: [owner, spender] }),
        onProgress: (done, total) => setFeeStatus(`Topping up fee notes: ${done}/${total}…`),
        onDeposited: (txHash) => addActivity(keys!.ownerKey, { kind: 'feenote', amount: FEE_NOTE_AMOUNT, txHash }),
      })
      if (deposited === 0) return { notes, sr }
      setFeeStatus(`Deposited ${deposited} fee note(s). Syncing…`)
      const fresh = await resync(sr.leaves.length + deposited)
      if (!fresh) throw new Error('Sync failed after fee deposit')
      return { notes: fresh.notes, sr: fresh.sr }
    }

    // Pre-flight for the biggest row, so the fee-note deposit is one wallet pop-up up front.
    setFeeStatus('Checking fee note…')
    try {
      const maxAmount = validRows.reduce((m, r) => (r.row.amount > m ? r.row.amount : m), 0n)
      const p0 = planPayment(currentNotes, maxAmount, feeAtoms, formatUsdc)
      if (!('error' in p0) && p0.needsFeeNote && !p0.feeNote) {
        const topped = await topUpFee(p0.inputs, currentNotes, currentSR)
        currentNotes = topped.notes
        currentSR    = topped.sr
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
      let lastTx: string | undefined

      const recipient = decodePiiAddress(row.piiAddress)

      // A row is one payment, or several when no two notes cover it. Each is sent in turn.
      const result = await sendInParts({
        sk:              keys.sk,
        encPub:          viewKeys.encPub,
        recipient,
        relayerAddr,
        relayerOwnerKey: relayerOK,
        fee:             feeAtoms,
        chainId:         BigInt(CHAIN_ID),
        fmt:             formatUsdc,
        prove:           async (inputs, onStage) => (await prove('transfer', inputs, onStage)).proof,
        relay:           (params) => relayTransfer(RELAY_BASE, params),
        topUpFee: async (inputs, notes, sr) => {
          const topped = await topUpFee(inputs, notes, sr)
          setFeeStatus(null)
          return topped
        },
        resync,
        onConfirmed: ({ amount: part, txHash }) => {
          addActivity(keys.ownerKey, { kind: 'payroll', amount: part, counterparty: row.piiAddress, txHash })
          lastTx = txHash
        },
      }, row.amount, currentNotes, currentSR)

      currentNotes = result.notes
      currentSR    = result.sr

      if (result.error || result.unconfirmed || result.sent < row.amount) {
        const left = row.amount - result.sent
        const msg = result.error
          ?? 'Not confirmed yet. Check Portfolio and Activity before retrying this row.'
        // If part of the row went out, keep only the remainder so Resume cannot pay it twice.
        setRows(prev => prev.map((r, j) =>
          j === i
            ? {
                ...r,
                status: 'failed',
                error: result.sent > 0n ? `${formatUsdc(result.sent)} already sent; ${formatUsdc(left)} remaining. ${msg}` : msg,
                row: result.sent > 0n ? { ...r.row, amount: left, rawAmount: formatUsdc(left) } : r.row,
              }
            : r
        ))
        setResumeIdx(i)
        setRunning(false)
        toast.error(`Row ${i + 1} failed: ${msg}`)
        return
      }

      setRows(prev => prev.map((r, j) => j === i ? { ...r, status: 'done', txHash: lastTx } : r))
      setResumeIdx(i + 1)

      if (result.syncFailed) {
        setRunning(false)
        toast.error(`Row ${i + 1} was paid, but syncing failed. Press Resume to continue.`)
        return
      }
    }
    setRunning(false)
    toast.success('Payroll complete')
  }

  const validRowCount = rows.filter(r => !r.row.error).length
  const total         = rows.reduce((a, r) => a + (r.row.error ? 0n : r.row.amount), 0n)
  const hasErrors     = rows.some(r => r.row.error)
  const legacyRows    = rows.filter(r => r.row.legacy && !r.row.error).length
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

      <div className="pii-card p-5 flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Payroll
        </p>
        <div className="flex flex-col gap-2 text-xs text-[var(--muted)]">
          <p>
            One payment per line: <span className="font-mono">pii_address,amount</span> in USDC.
            Each person copies their Pii address from their Portfolio.
          </p>
          <pre className="font-mono text-[10px] leading-relaxed rounded-lg bg-[var(--surface-muted)]
                          border border-[var(--border)] px-3 py-2 overflow-x-auto">{`pii_address,amount
pii:27f6fc54…,25.00
pii:9ab13e07…,12.50`}</pre>
          <button
            type="button"
            onClick={downloadSample}
            disabled={!keys}
            className="self-start inline-flex items-center gap-1.5 text-[var(--accent-hover)]
                       font-semibold hover:underline disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" />
            Download a sample CSV
          </button>
        </div>

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
                    {noFee ? '· no fee note needed' : `· needs 1 fee note (${formatUsdc(FEE_NOTE_AMOUNT)} USDC), reused across rows`}
                  </span>
                )}
              </span>
              <span className="font-semibold tabular-nums">{formatUsdc(total)} USDC total</span>
            </div>
            {validRowCount > 0 && (
              <p className={`text-[11px] ${capacity && capacity.transfersLeft < validRowCount ? 'text-[var(--danger)]' : 'text-[var(--subtle)]'}`}>
                About {validRowCount} {validRowCount === 1 ? 'minute' : 'minutes'}, one proof per row.
                {capacity && ` Relayer gas about ${(validRowCount * capacity.transferCostUsdc).toFixed(2)} USDC; it can cover about ${capacity.transfersLeft} payments now.`}
              </p>
            )}

            {legacyRows > 0 && (
              <p className="text-[11px] text-amber-700">
                {legacyRows} {legacyRows === 1 ? 'row uses' : 'rows use'} an old-format address with no network marker.
                Make sure {legacyRows === 1 ? 'it was' : 'they were'} copied from the {NETWORK} site.
              </p>
            )}

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
