/**
 * src/components/DepositTab.tsx
 */

import { useState, useEffect }                        from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { toast }                                      from 'sonner'
import { ArrowDownToLine, AlertCircle, Info }         from 'lucide-react'
import { usePii }                                     from '../contexts/PiiContext.js'
import {
  POOL_ADDRESS, USDC_ADDRESS, POOL_ABI, USDC_ABI,
  formatUsdc, parseUsdc, makePoolLike, 
} from '../lib/pii.js'
import { syncAfterTx }       from '../lib/sync.js'
import { recoverWallet }    from '@sdk/wallet'
import { depositSecret, randomBlinding } from '@sdk/note'
import { encryptMemo }      from '@sdk/memo'
import { addActivity }      from '../lib/activity.js'
import { AmountBox, Summary } from './ui.js'


// USDC_ID = keccak256(abi.encode(USDC_ADDR, 0)) mod r — pre-computed constant from golden_vectors.json
const USDC_ID = BigInt('0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86e')

export default function DepositTab() {
  const { address }                     = useAccount()
  const pub                             = usePublicClient()
  const { writeContractAsync }          = useWriteContract()
  const { keys, viewKeys, setWallet, startTask } = usePii()

  const [amount, setAmount]             = useState('')
  const [busy, setBusy]                 = useState(false)
  const [step, setStep]                 = useState<'idle' | 'approve' | 'deposit'>('idle')
  const [maxDeposit, setMaxDeposit]     = useState<bigint | null>(null)
  const [poolBal, setPoolBal]           = useState<bigint | null>(null)
  const [maxPool, setMaxPool]           = useState<bigint | null>(null)
  const [walletBal, setWalletBal]       = useState<bigint | null>(null)
  const [reload, setReload]             = useState(0)

  // The pool caps its own USDC balance (PiiPool.deposit checks usdc.balanceOf(pool)).
  useEffect(() => {
    if (!pub || !address) return
    void (async () => {
      try {
        const [md, mb, pb, wb] = await Promise.all([
          pub.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'maxDeposit' }),
          pub.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'maxPoolBalance' }),
          pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [POOL_ADDRESS] }),
          pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'balanceOf', args: [address] }),
        ])
        setMaxDeposit(md)
        setMaxPool(mb)
        setPoolBal(pb)
        setWalletBal(wb)
      } catch {
        toast.error('Could not load pool limits')
      }
    })()
  }, [pub, address, reload])

  /** Locks tab navigation while this runs, so a payment cannot be started twice or orphaned. */
  async function handleDeposit() {
    const end = startTask('Deposit')
    try { await depositInner() } finally { end() }
  }

  async function depositInner() {
    if (!keys || !viewKeys || !address || !pub) { toast.error('Unlock your wallet first'); return }
    const atoms = parseUsdc(amount)
    if (atoms <= 0n) { toast.error('Enter an amount'); return }
    if (maxDeposit && atoms > maxDeposit) {
      toast.error(`Max deposit is ${formatUsdc(maxDeposit)} USDC`); return
    }
    if (poolBal !== null && maxPool !== null && poolBal + atoms > maxPool) {
      toast.error(`Pool capacity exceeded`); return
    }
    if (walletBal !== null && atoms > walletBal) {
      toast.error(`Your wallet has only ${formatUsdc(walletBal)} USDC`); return
    }
    setBusy(true)
    try {
      setStep('approve')
      const allowance = await pub.readContract({
        address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'allowance',
        args: [address, POOL_ADDRESS],
      })
      if (allowance < atoms) {
        const approveTx = await writeContractAsync({
          address: USDC_ADDRESS, abi: USDC_ABI, functionName: 'approve',
          args: [POOL_ADDRESS, atoms],
        })
        await pub.waitForTransactionReceipt({ hash: approveTx })
      }

      const blinding  = randomBlinding()
      const secret    = depositSecret(keys.ownerKey, blinding)
      const memo      = encryptMemo(viewKeys.encPub, { assetId: USDC_ID, amount: atoms, blinding })

      setStep('deposit')
      const depositTx = await writeContractAsync({
        address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'deposit',
        args: [atoms, secret, memo],
        gas: 900_000n,
      })
      const receipt = await pub.waitForTransactionReceipt({ hash: depositTx })
      if (receipt.status !== 'success') throw new Error('Deposit transaction reverted')
      addActivity(keys.ownerKey, { kind: 'deposit', amount: atoms, txHash: depositTx })

      // The deposit is on-chain from here: a failed sync must not report it as failed.
      toast.success(`Deposited ${formatUsdc(atoms)} USDC`)
      setAmount('')
      setReload(r => r + 1)
      try {
        const sr    = await syncAfterTx(pub, depositTx)
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
      } catch {
        toast.message('Deposit confirmed. Press Refresh in Portfolio to see it.')
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Deposit failed')
    } finally {
      setBusy(false)
      setStep('idle')
    }
  }

  const capsReady   = maxDeposit !== null && maxPool !== null && poolBal !== null
  const remaining   = capsReady ? maxPool - poolBal : null
  const amountAtoms = parseUsdc(amount || '0')
  const overDeposit = maxDeposit !== null && amountAtoms > maxDeposit
  const overPool    = remaining !== null && amountAtoms > remaining
  const overWallet  = walletBal !== null && amountAtoms > walletBal

  // Quick amounts, limited to what this deposit can actually be.
  const limits = [maxDeposit, walletBal, remaining].filter((x): x is bigint => x !== null)
  const limit  = capsReady && limits.length > 0 ? limits.reduce((m, x) => (x < m ? x : m)) : null
  const depositChips = [
    ...['1', '2', '5'].filter(v => limit === null || parseUsdc(v) <= limit).map(v => ({ label: v, value: v })),
    ...(limit !== null && limit > 0n ? [{ label: 'Max', value: formatUsdc(limit) }] : []),
  ]

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      <div className="flex items-start gap-2 rounded-xl bg-[var(--surface-muted)]
                      border border-[var(--border)] px-3 py-2.5">
        <Info className="w-3.5 h-3.5 text-[var(--accent)] mt-0.5 flex-shrink-0" />
        <p className="text-[11px] text-[var(--muted)] leading-relaxed">
          Deposits are public: your address and the amount are visible on-chain.
          What you do inside the pool afterwards is private. Round amounts blend in better.
        </p>
      </div>

      <div className="pii-card p-5 flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Deposit USDC
        </p>

        <AmountBox label="You deposit" value={amount} onChange={setAmount} chips={depositChips} />
        {capsReady && (
          <p className="text-[11px] text-[var(--subtle)] px-1">
            {walletBal !== null && <>Wallet: {formatUsdc(walletBal)} · </>}
            Max per deposit: {formatUsdc(maxDeposit)} · Pool space: {formatUsdc(remaining !== null && remaining > 0n ? remaining : 0n)}
          </p>
        )}

        {(overDeposit || overPool || overWallet) && (
          <div className="flex items-center gap-2 text-[var(--danger)] text-xs px-1">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {overDeposit ? `Exceeds max deposit of ${formatUsdc(maxDeposit)} USDC`
              : overPool ? 'Exceeds pool capacity'
              : 'More than your wallet balance'}
          </div>
        )}

        {busy && (
          <p className="text-xs text-[var(--muted)] text-center">
            {step === 'approve' ? 'Approving USDC…' : step === 'deposit' ? 'Depositing…' : ''}
          </p>
        )}

        <button
          onClick={() => { void handleDeposit() }}
          disabled={busy || !keys || overDeposit || overPool || overWallet || amountAtoms <= 0n}
          className="flex items-center justify-center gap-2 h-12 rounded-xl
                     bg-[var(--accent)] text-white text-sm font-semibold
                     hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          <ArrowDownToLine className="w-4 h-4" />
          {busy ? 'Depositing…' : 'Deposit'}
        </button>
        <Summary>Public transaction · approve + deposit = 2 wallet confirmations</Summary>
      </div>
    </div>
  )
}
