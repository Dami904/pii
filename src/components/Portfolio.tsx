/**
 * src/components/Portfolio.tsx
 */

import { useState, useCallback, useEffect, useMemo } from 'react'
import { usePublicClient }                    from 'wagmi'
import { toast }                              from 'sonner'
import { RefreshCw, Lock, Copy, Check }      from 'lucide-react'
import { usePii }                             from '../contexts/PiiContext.js'
import { formatUsdc, makePoolLike, explorerTx } from '../lib/pii.js'
import { loadActivity, addActivityOnce, ACTIVITY_LABEL, shortAddr } from '../lib/activity.js'
import { getLeafMeta }                       from '../lib/sync.js'
import { Skeleton }                          from './ui.js'
import { findReceived, findReceivedSingles } from '../lib/received.js'
import { getTxKind }                         from '../lib/txkind.js'
import { syncPool }         from '../lib/sync.js'
import { recoverWallet }                      from '@sdk/wallet'
import { encodePiiAddress, scanNotes }       from '@sdk/memo'
import { isOwnAddress }                      from '../lib/address.js'
import { NETWORK }                           from '../lib/network.js'
import { leavesWithMemos }                  from '@sdk/tree'

const SHORT = 5   // rows shown before "Show all": keeps the page light
const when = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })

export default function Portfolio() {
  const pub                                   = usePublicClient()
  const { keys, viewKeys, wallet, setWallet } = usePii()
  const [syncing, setSyncing]                 = useState(false)
  const [copied, setCopied]                   = useState(false)
  const [rxTick, setRxTick]                   = useState(0)
  const [showAllNotes, setShowAllNotes]       = useState(false)
  const [showAllActivity, setShowAllActivity] = useState(false)

  // Recomputed whenever the wallet state changes (every send ends in a resync).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const activity = useMemo(() => (keys ? loadActivity(keys.ownerKey).slice(0, 20) : []), [keys, wallet, rxTick])

  // Payments we RECEIVED are not something this device did, so find them in the synced
  // chain data (spent ones too) and add each to Activity once.
  useEffect(() => {
    if (!keys || !viewKeys || !wallet || !pub) return
    let cancelled = false
    void (async () => {
      const owned = scanNotes(keys.ownerKey, viewKeys.encPriv, leavesWithMemos(wallet.syncResult))
      let added = false
      // Payments that spend a note exactly add one note, so they need the transaction itself.
      const sent = new Set(
        loadActivity(keys.ownerKey)
          .filter((a) => (a.kind === 'pay' || a.kind === 'payroll') && a.txHash)
          .map((a) => (a.txHash as string).toLowerCase()),
      )
      const singles = await findReceivedSingles(owned, getLeafMeta(), (tx) => getTxKind(pub, tx), sent)
      if (cancelled) return
      for (const r of [...findReceived(owned, getLeafMeta()), ...singles]) {
        const id = `rx:${r.leafIndex}`
        if (loadActivity(keys.ownerKey).some((a) => a.id === id)) continue
        let at = Date.now()
        try {
          const blk = await pub.getBlock({ blockNumber: r.block })
          at = Number(blk.timestamp) * 1000
        } catch { /* keep detection time */ }
        if (cancelled) return
        added = addActivityOnce(keys.ownerKey, id, { kind: 'receive', amount: r.amount, txHash: r.tx, at }) || added
      }
      if (added && !cancelled) setRxTick((t) => t + 1)
    })()
    return () => { cancelled = true }
  }, [keys, viewKeys, wallet, pub])

  const piiAddr = (keys && viewKeys) ? encodePiiAddress(keys.ownerKey, viewKeys.encPub, NETWORK) : null

  const notesNewestFirst = useMemo(
    () => (wallet ? [...wallet.notes].sort((a, b) => (b.leafIndex ?? 0) - (a.leafIndex ?? 0)) : []),
    [wallet],
  )
  const shownNotes = showAllNotes ? notesNewestFirst : notesNewestFirst.slice(0, SHORT)

  function handleCopy() {
    if (!piiAddr) return
    void navigator.clipboard.writeText(piiAddr)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const refresh = useCallback(async () => {
    if (!keys || !viewKeys || !pub) return
    setSyncing(true)
    try {
      const sr    = await syncPool(pub)
      const pool  = makePoolLike(pub)
      const store = await recoverWallet(
        keys.sk,
        { ownerKey: keys.ownerKey, encPriv: viewKeys.encPriv },
        sr,
        pool,
      )
      const notes = store.unspent()
      const total = notes.reduce((a, n) => a + n.amount, 0n)
      setWallet({ syncResult: sr, notes, totalBalance: total })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }, [keys, viewKeys, pub, setWallet])

  // Sync once right after unlock; Refresh stays available for later updates.
  useEffect(() => {
    if (!keys || wallet) return
    const t = setTimeout(() => { void refresh() }, 0)
    return () => clearTimeout(t)
  }, [keys, wallet, refresh])

  if (!keys) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-[var(--subtle)] text-sm">Unlock Pii to view your portfolio.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      {/* Pii address: what others need to pay you privately */}
      <div className="pii-card p-5 flex flex-col gap-3">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Your Pii address · {NETWORK}
        </p>
        <div className="flex items-start gap-2">
          <p className="font-mono text-xs text-[var(--ink-2)] break-all leading-relaxed flex-1">
            {piiAddr}
          </p>
          <button
            onClick={handleCopy}
            aria-label="Copy Pii address"
            className="p-2 rounded-lg hover:bg-[var(--surface-muted)] transition-colors flex-shrink-0"
          >
            {copied ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Copy className="w-4 h-4 text-[var(--subtle)]" />}
          </button>
        </div>
        <p className="text-xs text-[var(--subtle)]">
          Share this address to receive private payments on {NETWORK}. An address for the other network will not work here.
        </p>
      </div>

      <div className="pii-card p-6 flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Private USDC balance
        </p>
        <p className="font-display text-4xl font-700 text-[var(--ink)] tracking-tight tabular-nums">
          {wallet ? formatUsdc(wallet.totalBalance) : syncing ? <Skeleton className="h-10 w-40" /> : '—'}
          {(wallet || !syncing) && <span className="text-lg font-500 text-[var(--muted)] ml-2">USDC</span>}
        </p>
        <p className="text-xs text-[var(--subtle)]">
          {wallet
            ? `${wallet.notes.length} note${wallet.notes.length !== 1 ? 's' : ''}`
            : 'Not yet synced'}
        </p>
      </div>

      <button
        onClick={() => { void refresh() }}
        disabled={syncing}
        className="flex items-center justify-center gap-2 h-11 rounded-xl
                   bg-[var(--accent)] text-white text-sm font-semibold
                   hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
      >
        <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Syncing…' : 'Refresh'}
      </button>

      {!wallet && syncing && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {wallet && wallet.notes.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase px-1">
            Notes
          </p>
          {shownNotes.map((n) => (
            <div key={n.leafIndex}
              className="flex items-center justify-between rounded-xl bg-[var(--surface)]
                         border border-[var(--border)] px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Lock className="w-3.5 h-3.5 text-[var(--subtle)]" />
                <span className="text-xs text-[var(--muted)] font-mono">leaf {n.leafIndex}</span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-[var(--ink)]">
                {formatUsdc(n.amount)} USDC
              </span>
            </div>
          ))}
          {notesNewestFirst.length > SHORT && (
            <button type="button" onClick={() => setShowAllNotes(v => !v)}
              className="self-start px-1 text-xs font-semibold text-[var(--accent-hover)] hover:underline">
              {showAllNotes ? 'Show fewer' : `Show all ${notesNewestFirst.length} notes`}
            </button>
          )}
        </div>
      )}

      {wallet && wallet.notes.length === 0 && (
        <p className="text-sm text-[var(--subtle)] text-center py-4">
          No notes found. Deposit USDC to get started.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase px-1">
          Activity
        </p>
        {activity.length === 0 ? (
          <p className="text-xs text-[var(--subtle)] px-1">
            Nothing yet. Deposits, payments and withdrawals you make here will be listed.
          </p>
        ) : (showAllActivity ? activity : activity.slice(0, SHORT)).map((a) => {
          const incoming = a.kind === 'deposit' || a.kind === 'feenote' || a.kind === 'receive'
          // Paying your own address moves money between your own notes: no real in or out.
          const toSelf   = (a.kind === 'pay' || a.kind === 'payroll') && isOwnAddress(a.counterparty, keys.ownerKey)
          const label    = toSelf ? (a.kind === 'payroll' ? 'Payroll to yourself' : 'Payment to yourself') : ACTIVITY_LABEL[a.kind]
          const sign     = toSelf ? '' : incoming ? '+' : '−'
          const tone     = toSelf ? 'text-[var(--muted)]' : incoming ? 'text-[var(--success)]' : 'text-[var(--ink)]'
          const row = (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface)]
                            border border-[var(--border)] px-4 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--ink)]">{label}</p>
                <p className="text-[11px] text-[var(--subtle)] truncate font-mono">
                  {a.counterparty && !toSelf ? `${incoming ? 'from' : 'to'} ${shortAddr(a.counterparty)} · ` : ''}
                  {when(a.at)}
                </p>
              </div>
              <span className={`text-sm font-semibold tabular-nums flex-shrink-0 ${tone}`}>
                {sign}{formatUsdc(BigInt(a.amount))}
              </span>
            </div>
          )
          return a.txHash
            ? <a key={a.id} href={explorerTx(a.txHash)} target="_blank" rel="noopener noreferrer"
                 className="block hover:opacity-90">{row}</a>
            : <div key={a.id}>{row}</div>
        })}
        {activity.length > SHORT && (
          <button type="button" onClick={() => setShowAllActivity(v => !v)}
            className="self-start px-1 text-xs font-semibold text-[var(--accent-hover)] hover:underline">
            {showAllActivity ? 'Show fewer' : `Show all ${activity.length} entries`}
          </button>
        )}
        {activity.length > 0 && (
          <p className="text-[11px] text-[var(--subtle)] px-1">
            What you send is kept in this browser; what you receive is rebuilt from the chain on Refresh.
          </p>
        )}
      </div>
    </div>
  )
}
