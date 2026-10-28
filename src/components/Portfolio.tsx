/**
 * src/components/Portfolio.tsx
 */

import { useState, useCallback }              from 'react'
import { usePublicClient }                    from 'wagmi'
import { toast }                              from 'sonner'
import { RefreshCw, Lock }                    from 'lucide-react'
import { usePii }                             from '../contexts/PiiContext.js'
import { POOL_ADDRESS, DEPLOY_BLOCK, formatUsdc, makePoolLike, makePoolContractLike } from '../lib/pii.js'
import { syncTree }                           from '@sdk/tree'
import { recoverWallet }                      from '@sdk/wallet'
import type { PublicClientLike }              from '@sdk/tree'

export default function Portfolio() {
  const pub                                   = usePublicClient()
  const { keys, viewKeys, wallet, setWallet } = usePii()
  const [syncing, setSyncing]                 = useState(false)

  const refresh = useCallback(async () => {
    if (!keys || !viewKeys || !pub) return
    setSyncing(true)
    try {
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
      const total = notes.reduce((a, n) => a + n.amount, 0n)
      setWallet({ syncResult: sr, notes, totalBalance: total })
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }, [keys, viewKeys, pub, setWallet])

  if (!keys) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-[var(--subtle)] text-sm">Unlock Pii to view your portfolio.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      <div className="rounded-2xl bg-[var(--surface-strong)] border border-[var(--border)]
                      backdrop-blur-sm p-6 flex flex-col gap-2">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Private USDC balance
        </p>
        <p className="font-display text-4xl font-700 text-[var(--ink)] tracking-tight tabular-nums">
          {wallet ? formatUsdc(wallet.totalBalance) : '—'}
          <span className="text-lg font-500 text-[var(--muted)] ml-2">USDC</span>
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

      {wallet && wallet.notes.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase px-1">
            Notes
          </p>
          {wallet.notes.map((n, i) => (
            <div key={i}
              className="flex items-center justify-between rounded-xl bg-[var(--surface)]
                         border border-[var(--border)] px-4 py-3">
              <div className="flex items-center gap-2">
                <Lock className="w-3.5 h-3.5 text-[var(--subtle)]" />
                <span className="text-xs text-[var(--muted)] font-mono">leaf {n.leafIndex}</span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-[var(--ink)]">
                {formatUsdc(n.amount)} USDC
              </span>
            </div>
          ))}
        </div>
      )}

      {wallet && wallet.notes.length === 0 && (
        <p className="text-sm text-[var(--subtle)] text-center py-4">
          No notes found. Deposit USDC to get started.
        </p>
      )}
    </div>
  )
}
