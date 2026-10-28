/**
 * src/components/WithdrawTab.tsx
 */

import { useState, useEffect }                       from 'react'
import { usePublicClient }                           from 'wagmi'
import { toast }                                     from 'sonner'
import { ArrowUpFromLine, AlertTriangle, Loader, ExternalLink } from 'lucide-react'
import { usePii }                                    from '../contexts/PiiContext.js'
import {
  POOL_ADDRESS, DEPLOY_BLOCK, RELAY_BASE,
  formatUsdc, parseUsdc, explorerTx, makePoolLike, makePoolContractLike,
} from '../lib/pii.js'
import { prepareWithdraw }                           from '../lib/pii-ops.js'
import { prove }                                     from '../lib/worker-bridge.js'
import { syncTree }                                  from '@sdk/tree'
import { recoverWallet }                             from '@sdk/wallet'
import { relayWithdraw, getRelayerInfo }             from '@sdk/relayer'
import type { PublicClientLike }                     from '@sdk/tree'
import { isAddress, type Hex }                       from 'viem'

type TxStatus = 'idle' | 'proving' | 'submitting' | 'confirmed' | 'unknown' | 'failed'

const RELAYER_FEE = 1000n

export default function WithdrawTab() {
  const pub                                    = usePublicClient()
  const { keys, viewKeys, wallet, setWallet }  = usePii()

  const [dest, setDest]           = useState('')
  const [amount, setAmount]       = useState('')
  const [stage, setStage]         = useState<string | null>(null)
  const [txStatus, setTxStatus]   = useState<TxStatus>('idle')
  const [txHash, setTxHash]       = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [relayerAddr, setRelayerAddr] = useState<Hex | null>(null)

  useEffect(() => {
    void getRelayerInfo(RELAY_BASE).then(info => setRelayerAddr(info.relayerAddress)).catch(() => {})
  }, [])

  const atoms     = parseUsdc(amount || '0')
  const matchNote = wallet?.notes.find(n => n.amount === atoms)
  const showWarn  = matchNote !== undefined && atoms > 0n

  async function handleWithdraw() {
    if (!keys || !viewKeys || !wallet) { toast.error('Unlock and sync wallet first'); return }
    if (!isAddress(dest))   { toast.error('Invalid destination address'); return }
    if (atoms <= 0n)        { toast.error('Enter an amount'); return }
    if (!relayerAddr)       { toast.error('Relayer unavailable'); return }

    const sorted = [...wallet.notes].sort((a, b) => (b.amount > a.amount ? 1 : -1))
    const note   = sorted.find(n => n.amount >= atoms)
    if (!note) { toast.error(`Need at least ${formatUsdc(atoms)} USDC in a note`); return }

    setBusy(true)
    setError(null)
    setTxHash(null)
    setTxStatus('proving')

    try {
      const prep = prepareWithdraw({
        sk:           keys.sk,
        note,
        tree:         wallet.syncResult.tree,
        amount:       atoms,
        fee:          RELAYER_FEE,
        relayerAddr,
        recipient:    dest,
        chainId:      BigInt(pub?.chain?.id ?? 5042002),
      })

      setStage('witness')
      const { proof } = await prove('withdraw', prep.inputs, (s) => setStage(s))

      setTxStatus('submitting')
      const hexProof: `0x${string}` = `0x${Buffer.from(proof).toString('hex')}`
      prep.relayParams.proof = hexProof

      const result = await relayWithdraw(RELAY_BASE, prep.relayParams)

      if (result.status === 'confirmed' && result.txHash) {
        setTxHash(result.txHash)
        setTxStatus('confirmed')
        if (pub) {
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
        }
        setAmount('')
        setDest('')
      } else if (result.status === 'unknown') {
        setTxStatus('unknown')
      } else {
        setTxStatus('failed')
        setError('Withdrawal not confirmed')
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setTxStatus('failed')
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  const [busy, setBusy] = useState(false)

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      <div className="rounded-2xl bg-[var(--surface-strong)] border border-[var(--border)]
                      backdrop-blur-sm p-5 flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Withdraw
        </p>

        <input
          placeholder="0x… destination address"
          value={dest}
          onChange={e => setDest(e.target.value)}
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

        {showWarn && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 leading-relaxed">
              This amount matches one of your deposits. Consider a different amount or waiting.
            </p>
          </div>
        )}

        {busy && stage && (
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <Loader className="w-3.5 h-3.5 animate-spin" />
            {txStatus === 'proving' ? `Proving: ${stage}…` : 'Sending to relayer…'}
          </div>
        )}

        {txStatus === 'confirmed' && txHash && (
          <a href={explorerTx(txHash)} target="_blank" rel="noopener noreferrer"
             className="flex items-center gap-1 text-xs text-[var(--success)] hover:underline">
            <ExternalLink className="w-3 h-3" />
            Withdrawal confirmed
          </a>
        )}
        {txStatus === 'unknown' && (
          <p className="text-xs text-[var(--muted)]">Status unknown — checking…</p>
        )}
        {txStatus === 'failed' && error && (
          <p className="text-xs text-[var(--danger)]">{error}</p>
        )}

        <button
          onClick={() => { void handleWithdraw() }}
          disabled={busy || !keys || !amount || !dest || !relayerAddr}
          className="flex items-center justify-center gap-2 h-12 rounded-xl
                     bg-[var(--accent)] text-white text-sm font-semibold
                     hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          <ArrowUpFromLine className="w-4 h-4" />
          {busy ? 'Proving…' : 'Withdraw'}
        </button>
      </div>
    </div>
  )
}
