/**
 * src/components/PayTab.tsx
 */

import { useState, useEffect }                        from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { toast }                                      from 'sonner'
import { Send, Loader, Info }                         from 'lucide-react'
import { usePii }                                     from '../contexts/PiiContext.js'
import {
  RELAY_BASE,
  formatUsdc, parseUsdc, explorerTx, makePoolLike, 
  USDC_ADDRESS, USDC_ABI, CHAIN_ID,
} from '../lib/pii.js'
import { ensureFeeNotes, FEE_NOTE_AMOUNT } from '../lib/pii-ops.js'
import { prove }                                      from '../lib/worker-bridge.js'
import { syncPool }         from '../lib/sync.js'
import { recoverWallet }                              from '@sdk/wallet'
import { checkAddress }                               from '../lib/address.js'
import { addActivity }                                from '../lib/activity.js'
import type { Note }                                  from '@sdk/note'
import type { SyncResult }                            from '@sdk/tree'
import { planPayment }                                from '../lib/pay-plan.js'
import { simulateParts, sendInParts }                 from '../lib/pay-parts.js'
import { ACTIVE_CHAIN, NETWORK }                      from '../lib/network.js'
import { AmountBox, Summary }                         from './ui.js'
import { relayTransfer, getRelayerInfo, type RelayerInfo } from '@sdk/relayer'
import { relayerCapacity }                            from '../lib/relayer-gas.js'
import type { Hex }                                   from 'viem'

type TxStatus = 'idle' | 'fee-notes' | 'proving' | 'submitting' | 'confirmed' | 'failed' | 'unknown'

const RELAYER_FEE = 1000n

export default function PayTab() {
  const { address }                              = useAccount()
  const pub                                      = usePublicClient()
  const { writeContractAsync }                   = useWriteContract()
  const { keys, viewKeys, wallet, setWallet, startTask } = usePii()

  const [recipient, setRecipient]   = useState('')
  const [amount, setAmount]         = useState('')
  const [stage, setStage]           = useState<string | null>(null)
  const [txStatus, setTxStatus]     = useState<TxStatus>('idle')
  const [txHash, setTxHash]         = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [relayerAddr, setRelayerAddr] = useState<Hex | null>(null)
  const [relayerOK, setRelayerOK]    = useState<bigint | null>(null)
  const [feeProgress, setFeeProgress] = useState<string | null>(null)
  const [partLabel, setPartLabel] = useState<string | null>(null)
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

  /**
   * Resync and update wallet state. Returns the fresh tree too: setWallet does not
   * update `wallet` inside a running handler, so callers must prove against `sr`.
   */
  async function resync(minLeaves = 0) {
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

  /** Locks tab navigation while this runs, so a payment cannot be started twice or orphaned. */
  async function handlePay() {
    const end = startTask('Payment')
    try { await payInner() } finally { end() }
  }

  async function payInner() {
    if (!keys || !viewKeys || !pub || !address) { toast.error('Unlock wallet first'); return }
    if (!wallet || wallet.notes.length === 0)   { toast.error('No notes — deposit first'); return }
    if (!relayerAddr || relayerOK === null)      { toast.error('Relayer unavailable'); return }

    const atoms = parseUsdc(amount)
    if (atoms <= 0n) { toast.error('Enter an amount'); return }

    const addrCheck = checkAddress(recipient, NETWORK)
    if (!addrCheck.ok) { toast.error(addrCheck.message); return }
    const decoded = addrCheck.decoded

    // How many payments does this take? (Two notes per payment; more are sent one after another.)
    const planned = simulateParts(wallet.notes, atoms, feeAtoms, formatUsdc)
    if ('error' in planned) { toast.error(planned.error); return }
    if (capacity && capacity.transfersLeft < planned.parts.length) {
      toast.error(`The relayer is low on gas (about ${capacity.transfersLeft} payments left, this needs ${planned.parts.length}). Please try again later.`)
      return
    }

    setError(null)
    setTxHash(null)

    // Aliases keep the narrowing from the guards above inside the helper below.
    const k = keys, vk = viewKeys, p = pub, addr = address

    // Deposit a fee note when no spare note can pay the relayer fee.
    async function topUpFee(inputs: Note[], notes: Note[], sr: SyncResult) {
      setTxStatus('fee-notes')
      setFeeProgress('Depositing fee note (0/1)…')
      const deposited = await ensureFeeNotes({
        notes,
        inNote:      inputs[0],
        inNote2:     inputs[1],
        minFee:      RELAYER_FEE,
        needed:      1,
        ownerKey:    k.ownerKey,
        viewKeys:    vk,
        userAddress: addr,
        write: async (args) => {
          const hash = await writeContractAsync(args as Parameters<typeof writeContractAsync>[0])
          return hash
        },
        waitReceipt: async (hash) => { await p.waitForTransactionReceipt({ hash }) },
        readAllowance: (owner, spender) =>
          p.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'allowance', args: [owner, spender] }),
        onProgress: (done, total) => setFeeProgress(`Depositing fee note (${done}/${total})…`),
        onDeposited: (txHash) => addActivity(k.ownerKey, { kind: 'feenote', amount: FEE_NOTE_AMOUNT, txHash }),
      })
      setFeeProgress(null)
      if (deposited === 0) return { notes, sr }
      const fresh = await resync(sr.leaves.length + deposited)
      if (!fresh) throw new Error('Sync failed after fee deposit')
      return fresh
    }

    const result = await sendInParts({
      sk:              k.sk,
      encPub:          vk.encPub,
      recipient:       decoded,
      relayerAddr,
      relayerOwnerKey: relayerOK,
      fee:             feeAtoms,
      chainId:         BigInt(CHAIN_ID),
      fmt:             formatUsdc,
      prove:           async (inputs, onStage) => (await prove('transfer', inputs, onStage)).proof,
      relay:           (params) => relayTransfer(RELAY_BASE, params),
      topUpFee,
      resync,
      onPart:          (i, n) => setPartLabel(n > 1 ? `Payment ${i} of ${n}` : null),
      onStatus:        setTxStatus,
      onStage:         setStage,
      onConfirmed:     ({ amount: part, txHash: hash }) => {
        setTxHash(hash)
        addActivity(k.ownerKey, { kind: 'pay', amount: part, counterparty: recipient, txHash: hash })
      },
    }, atoms, wallet.notes, wallet.syncResult)

    setStage(null)
    setFeeProgress(null)
    setPartLabel(null)

    const left = atoms - result.sent
    if (result.error || result.unconfirmed) {
      if (result.sent > 0n) {
        // Part of it already went out: set the amount to what is left so a retry cannot repeat it.
        setAmount(formatUsdc(left))
        setTxStatus('failed')
        setError(
          `${formatUsdc(result.sent)} USDC was already sent. ` +
          (result.error ?? 'The next payment was not confirmed in time. Press Refresh in Portfolio and check Activity before sending the rest.') +
          ` The amount is now the remaining ${formatUsdc(left)}.`,
        )
      } else if (result.unconfirmed) {
        setTxStatus('unknown')
      } else {
        setTxStatus('failed')
        setError(result.error ?? 'Transfer not confirmed.')
      }
      return
    }

    setTxStatus('confirmed')
    setAmount('')
    setRecipient('')
    if (result.syncFailed) toast.message('Payment confirmed. Press Refresh in Portfolio to update your balance.')
  }

  const busy = txStatus === 'fee-notes' || txStatus === 'proving' || txStatus === 'submitting'

  // An address for the other network would send money to keys nobody holds here.
  const recipientCheck = recipient.trim() ? checkAddress(recipient, NETWORK) : null
  const wrongNetwork   = recipientCheck !== null && !recipientCheck.ok && recipientCheck.kind === 'wrong-network'

  // How many payments the typed amount takes (null until there is an amount).
  const typed  = parseUsdc(amount || '0')
  const sim    = wallet && typed > 0n ? simulateParts(wallet.notes, typed, feeAtoms, formatUsdc) : null
  const nParts = sim && 'parts' in sim ? sim.parts.length : 1

  // Quick amounts: one payment can combine the two largest notes.
  const topTwo = wallet
    ? [...wallet.notes].sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0))
        .slice(0, 2).reduce((sum, n) => sum + n.amount, 0n)
    : 0n
  const payChips = [
    ...['1', '2', '5'].filter(v => topTwo === 0n || parseUsdc(v) <= topTwo).map(v => ({ label: v, value: v })),
    ...(topTwo > 0n ? [{ label: 'Max', value: formatUsdc(topTwo) }] : []),
  ]

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      {/* Info blurb */}
      <div className="flex items-start gap-2 rounded-xl bg-[var(--surface-muted)]
                      border border-[var(--border)] px-3 py-2.5">
        <Info className="w-3.5 h-3.5 text-[var(--accent)] mt-0.5 flex-shrink-0" />
        <p className="text-[11px] text-[var(--muted)] leading-relaxed">
          {noFee
            ? 'Payments are free during the beta: the relayer pays the network fee and never sees your address.'
            : 'Each private payment uses a small separate fee note (0.02 USDC) so the relayer can pay gas without seeing your address. One will be deposited automatically if needed.'}
        </p>
      </div>

      {capacity?.low && (
        <p className="text-[11px] text-[var(--danger)] px-1">
          The relayer is low on gas: about {capacity.transfersLeft} {capacity.transfersLeft === 1 ? 'payment' : 'payments'} left.
        </p>
      )}

      <div className="pii-card p-5 flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">Pay</p>

        <div className="flex flex-col gap-3">
          <input
            placeholder="pii:… recipient"
            value={recipient}
            onChange={e => setRecipient(e.target.value)}
            className="h-11 pii-field px-4 text-sm font-mono text-[var(--ink)] outline-none
                       focus:border-[var(--focus)] transition-colors"
          />
          {recipientCheck && !recipientCheck.ok && recipientCheck.kind === 'wrong-network' && (
            <p className="text-[11px] text-[var(--danger)] px-1">{recipientCheck.message}</p>
          )}
          {recipientCheck?.ok && recipientCheck.legacy && (
            <p className="text-[11px] text-amber-700 px-1">
              This address has no network marker. Make sure it was copied from the {NETWORK} site.
            </p>
          )}
          <AmountBox
            label="You send"
            value={amount}
            onChange={setAmount}
            hint="Hidden on-chain: only the recipient can see this amount."
            chips={payChips}
          />
        </div>

        {/* How this payment will be made */}
        {wallet && sim && 'parts' in sim && (() => {
          const one = planPayment(wallet.notes, typed, feeAtoms, formatUsdc)
          return (
            <>
              {sim.parts.length > 1 && (
                <p className="text-[11px] text-[var(--muted)] px-1">
                  No two notes cover this, so it is sent in {sim.parts.length} payments
                  ({sim.parts.map(x => formatUsdc(x)).join(' + ')}){noFee ? '.' : `, each with its own ${formatUsdc(RELAYER_FEE)} USDC fee.`}
                  The recipient gets {sim.parts.length} notes that add up to the amount.
                </p>
              )}
              {sim.parts.length === 1 && !('error' in one) && one.inputs.length > 1 && (
                <p className="text-[11px] text-[var(--muted)] px-1">
                  No single note covers this, so it combines your two largest
                  ({formatUsdc(one.inputs[0].amount)} + {formatUsdc(one.inputs[1].amount)}) in one payment.
                </p>
              )}
              {sim.feeDeposits > 0 && (
                <p className="text-[11px] text-[var(--muted)] px-1">
                  One-time setup: a {formatUsdc(FEE_NOTE_AMOUNT)} USDC fee note will be deposited
                  from your wallet first. Each payment uses {formatUsdc(RELAYER_FEE)} of it and the rest stays yours.
                </p>
              )}
            </>
          )
        })()}

        {busy && (
          <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
            <Loader className="w-3.5 h-3.5 animate-spin" />
            {partLabel ? `${partLabel}: ` : ''}
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
          <p className="text-xs text-[var(--muted)]">
            The relayer did not confirm in time. Press Refresh in Portfolio in a minute to see
            whether it went through. Retrying is safe: a note can never be spent twice.
          </p>
        )}
        {txStatus === 'failed' && error && (
          <p className="text-xs text-[var(--danger)]">{error}</p>
        )}

        <button
          onClick={() => { void handlePay() }}
          disabled={busy || !keys || parseUsdc(amount || '0') <= 0n || !recipient || wrongNetwork || !relayerAddr}
          className="flex items-center justify-center gap-2 h-12 rounded-xl
                     bg-[var(--accent)] text-white text-sm font-semibold
                     hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          <Send className="w-4 h-4" />
          {busy ? (partLabel ?? (txStatus === 'fee-notes' ? 'Topping up…' : 'Proving…')) : nParts > 1 ? `Send privately (${nParts} payments)` : 'Send privately'}
        </button>
        <Summary>{noFee ? 'No fee' : `Fee ${formatUsdc(RELAYER_FEE * BigInt(nParts))} USDC`} · {ACTIVE_CHAIN.name} · about {nParts} {nParts > 1 ? 'minutes' : 'minute'}</Summary>
      </div>
    </div>
  )
}
