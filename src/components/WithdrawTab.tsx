/**
 * src/components/WithdrawTab.tsx
 */

import { useState, useEffect }                       from 'react'
import { useAccount, usePublicClient }               from 'wagmi'
import { toast }                                     from 'sonner'
import { ArrowUpFromLine, AlertTriangle, Loader, ExternalLink } from 'lucide-react'
import { usePii }                                    from '../contexts/PiiContext.js'
import {
  RELAY_BASE, CHAIN_ID,
  formatUsdc, parseUsdc, explorerTx, makePoolLike, 
} from '../lib/pii.js'
import { prepareWithdraw }                           from '../lib/pii-ops.js'
import { planWithdraw }                              from '../lib/withdraw-plan.js'
import { ACTIVE_CHAIN }                              from '../lib/network.js'
import { AmountBox, Summary }                        from './ui.js'
import { prove }                                     from '../lib/worker-bridge.js'
import { syncPool }         from '../lib/sync.js'
import { recoverWallet }                             from '@sdk/wallet'
import { relayWithdraw, getRelayerInfo, type RelayerInfo } from '@sdk/relayer'
import { relayerCapacity }                           from '../lib/relayer-gas.js'
import { addActivity }                               from '../lib/activity.js'
import { isAddress, type Hex }                       from 'viem'

type TxStatus = 'idle' | 'proving' | 'submitting' | 'confirmed' | 'unknown' | 'failed'

const RELAYER_FEE = 1000n

export default function WithdrawTab() {
  const { address }                            = useAccount()
  const pub                                    = usePublicClient()
  const { keys, viewKeys, wallet, setWallet, startTask } = usePii()

  const [dest, setDest]           = useState('')
  const [amount, setAmount]       = useState('')
  const [busy, setBusy]           = useState(false)
  const [stage, setStage]         = useState<string | null>(null)
  const [txStatus, setTxStatus]   = useState<TxStatus>('idle')
  const [txHash, setTxHash]       = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [relayerAddr, setRelayerAddr] = useState<Hex | null>(null)
  const [relayerDown, setRelayerDown] = useState(false)
  const [relayerInfo, setRelayerInfo] = useState<RelayerInfo | null>(null)
  const [partLabel, setPartLabel] = useState<string | null>(null)

  useEffect(() => {
    void getRelayerInfo(RELAY_BASE)
      .then(info => { setRelayerAddr(info.relayerAddress); setRelayerInfo(info) })
      .catch(() => setRelayerDown(true))
  }, [])

  const capacity = relayerCapacity(relayerInfo, BigInt(relayerInfo?.minFee ?? '1') === 0n)

  const atoms     = parseUsdc(amount || '0')
  const matchNote = wallet?.notes.find(n => n.amount === atoms)
  const showWarn  = matchNote !== undefined && atoms > 0n
  const sameAddr  = !!address && isAddress(dest) && dest.toLowerCase() === address.toLowerCase()
  const tooSmall  = atoms > 0n && atoms <= RELAYER_FEE
  // A withdrawal spends one note; a bigger amount is split across notes automatically.
  const plan      = wallet && atoms > RELAYER_FEE ? planWithdraw(wallet.notes, atoms, RELAYER_FEE, formatUsdc) : null
  const parts     = plan && 'parts' in plan ? plan.parts : null
  const nParts    = parts?.length ?? 1

  /** Locks tab navigation while this runs, so a payment cannot be started twice or orphaned. */
  async function handleWithdraw() {
    const end = startTask('Withdrawal')
    try { await withdrawInner() } finally { end() }
  }

  async function withdrawInner() {
    if (!keys || !viewKeys || !wallet) { toast.error('Unlock and sync wallet first'); return }
    if (!isAddress(dest))   { toast.error('Invalid destination address'); return }
    if (atoms <= 0n)        { toast.error('Enter an amount'); return }
    if (tooSmall)           { toast.error(`Amount must be more than the ${formatUsdc(RELAYER_FEE)} USDC fee`); return }
    if (!relayerAddr)       { toast.error('Relayer unavailable'); return }

    const planned = planWithdraw(wallet.notes, atoms, RELAYER_FEE, formatUsdc)
    if ('error' in planned) { toast.error(planned.error); return }
    if (capacity && capacity.withdrawalsLeft < planned.parts.length) {
      toast.error('The relayer is out of gas for this withdrawal. Please try again later.')
      return
    }

    setBusy(true)
    setError(null)
    setTxHash(null)
    setTxStatus('proving')

    let sr          = wallet.syncResult
    let sent        = 0n
    let unconfirmed = false
    const n         = planned.parts.length

    try {
      for (let i = 0; i < n; i++) {
        const part = planned.parts[i]
        setPartLabel(n > 1 ? `Part ${i + 1} of ${n}` : null)
        setTxStatus('proving')

        const prep = prepareWithdraw({
          sk:           keys.sk,
          encPub:       viewKeys.encPub,
          note:         part.note,
          tree:         sr.tree,
          amount:       part.amount,
          fee:          RELAYER_FEE,
          relayerAddr,
          recipient:    dest,
          chainId:      BigInt(CHAIN_ID),
        })

        setStage('witness')
        const { proof } = await prove('withdraw', prep.inputs, (st) => setStage(st))

        setTxStatus('submitting')
        prep.relayParams.proof = `0x${Buffer.from(proof).toString('hex')}`
        const result = await relayWithdraw(RELAY_BASE, prep.relayParams)

        if (result.status === 'unknown') { unconfirmed = true; break }
        if (result.status !== 'confirmed' || !result.txHash) throw new Error('Withdrawal not confirmed')

        setTxHash(result.txHash)
        addActivity(keys.ownerKey, { kind: 'withdraw', amount: part.amount, counterparty: dest, txHash: result.txHash })
        sent += part.amount

        // Fresh sync before the next part (a partial withdrawal adds a change note).
        // This part is final: a failed sync must not report it as failed.
        try {
          if (pub) {
            sr = await syncPool(pub, sr.leaves.length + (part.note.amount > part.amount ? 1 : 0))
            const store = await recoverWallet(
              keys.sk,
              { ownerKey: keys.ownerKey, encPriv: viewKeys.encPriv },
              sr,
              makePoolLike(pub),
            )
            const notes = store.unspent()
            setWallet({ syncResult: sr, notes, totalBalance: notes.reduce((a, x) => a + x.amount, 0n) })
          }
        } catch {
          if (i < n - 1) throw new Error('Sync failed between parts')
          toast.message('Withdrawal confirmed. Press Refresh in Portfolio to update your balance.')
        }
      }

      if (unconfirmed) {
        setTxStatus('unknown')
      } else {
        setTxStatus('confirmed')
        setAmount('')
        setDest('')
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (sent > 0n) {
        // Part of it already went out: set the amount to what is left so a retry cannot repeat it.
        setAmount(formatUsdc(atoms - sent))
        setError(`${msg}. ${formatUsdc(sent)} USDC was already sent. The amount is now the remaining ${formatUsdc(atoms - sent)}; press Withdraw to continue.`)
      } else {
        setError(msg)
      }
      setTxStatus('failed')
    } finally {
      setBusy(false)
      setStage(null)
      setPartLabel(null)
    }
  }

  // Quick amounts: a withdrawal may be split across notes, so the whole balance is the limit.
  const total = wallet?.totalBalance ?? 0n
  const withdrawChips = [
    ...['1', '2', '5'].filter(v => total === 0n || parseUsdc(v) <= total).map(v => ({ label: v, value: v })),
    ...(total > 0n ? [{ label: 'Max', value: formatUsdc(total) }] : []),
  ]

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      <div className="pii-card p-5 flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Withdraw
        </p>

        <input
          placeholder="0x… destination address"
          value={dest}
          onChange={e => setDest(e.target.value)}
          className="h-11 pii-field px-4 text-sm font-mono text-[var(--ink)] outline-none
                     focus:border-[var(--focus)] transition-colors"
        />

        <AmountBox
          label="You withdraw"
          value={amount}
          onChange={setAmount}
          resultLabel={nParts > 1 ? 'Recipient gets, after fees' : 'Recipient gets, after fee'}
          resultValue={atoms > RELAYER_FEE * BigInt(nParts) ? formatUsdc(atoms - RELAYER_FEE * BigInt(nParts)) : '0.00'}
          hint={atoms > RELAYER_FEE && parts && nParts > 1
            ? `Your largest note is smaller than this, so it is sent in ${nParts} withdrawals (${parts.map((p) => formatUsdc(p.amount)).join(' + ')}), each with its own ${formatUsdc(RELAYER_FEE)} USDC fee.`
            : undefined}
          chips={withdrawChips}
        />

        {sameAddr && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 leading-relaxed">
              This is your connected wallet. Withdrawing to the address you deposited from
              links the two on-chain. Use a fresh address for privacy.
            </p>
          </div>
        )}

        {showWarn && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 p-3">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 leading-relaxed">
              This amount matches one of your deposits. Consider a different amount or waiting.
            </p>
          </div>
        )}

        {relayerDown && (
          <p className="text-xs text-[var(--danger)]">Relayer unavailable. Try again later.</p>
        )}

        {busy && stage && (
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <Loader className="w-3.5 h-3.5 animate-spin" />
            {partLabel ? `${partLabel}: ` : ''}{txStatus === 'proving' ? `Proving: ${stage}…` : 'Sending to relayer…'}
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
          <p className="text-xs text-[var(--muted)]">
            The relayer did not confirm in time. Press Refresh in Portfolio in a minute to see
            whether it went through. Retrying is safe: a note can never be spent twice.
          </p>
        )}
        {txStatus === 'failed' && error && (
          <p className="text-xs text-[var(--danger)]">{error}</p>
        )}

        <button
          onClick={() => { void handleWithdraw() }}
          disabled={busy || !keys || atoms <= RELAYER_FEE || !isAddress(dest) || !relayerAddr}
          className="flex items-center justify-center gap-2 h-12 rounded-xl
                     bg-[var(--accent)] text-white text-sm font-semibold
                     hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          <ArrowUpFromLine className="w-4 h-4" />
          {busy ? (partLabel ?? 'Proving…') : nParts > 1 ? `Withdraw (${nParts} parts)` : 'Withdraw'}
        </button>
        <Summary>Fee {formatUsdc(RELAYER_FEE * BigInt(nParts))} USDC · {ACTIVE_CHAIN.name} · about {nParts} {nParts > 1 ? 'minutes' : 'minute'}</Summary>
      </div>
    </div>
  )
}
