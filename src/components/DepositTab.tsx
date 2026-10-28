/**
 * src/components/DepositTab.tsx
 */

import { useState, useEffect }                        from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { toast }                                      from 'sonner'
import { ArrowDownToLine, AlertCircle }               from 'lucide-react'
import { usePii }                                     from '../contexts/PiiContext.js'
import {
  POOL_ADDRESS, USDC_ADDRESS, POOL_ABI, USDC_ABI,
  formatUsdc, parseUsdc, DEPLOY_BLOCK, makePoolLike, makePoolContractLike,
} from '../lib/pii.js'
import { syncTree }         from '@sdk/tree'
import { recoverWallet }    from '@sdk/wallet'
import { depositSecret }    from '@sdk/note'
import { encryptMemo }      from '@sdk/memo'

import type { PublicClientLike } from '@sdk/tree'

// USDC_ID = keccak256(abi.encode(USDC_ADDR, 0)) mod r — pre-computed constant from golden_vectors.json
const USDC_ID = BigInt('0x07db0ab36b82e923f962dc97079a2321c10234f3faf2b14672413ffd3838d86e')

export default function DepositTab() {
  const { address }                     = useAccount()
  const pub                             = usePublicClient()
  const { writeContractAsync }          = useWriteContract()
  const { keys, viewKeys, setWallet }   = usePii()

  const [amount, setAmount]             = useState('')
  const [busy, setBusy]                 = useState(false)
  const [step, setStep]                 = useState<'idle' | 'approve' | 'deposit'>('idle')
  const [maxDeposit, setMaxDeposit]     = useState<bigint | null>(null)
  const [poolBal, setPoolBal]           = useState<bigint | null>(null)
  const [maxPool, setMaxPool]           = useState<bigint | null>(null)

  useEffect(() => {
    if (!pub) return
    void (async () => {
      const [md, mb, pb] = await Promise.all([
        pub.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'maxDeposit' }),
        pub.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'maxPoolBalance' }),
        pub.readContract({ address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'currentPoolBalance' }),
      ])
      setMaxDeposit(md)
      setMaxPool(mb)
      setPoolBal(pb)
    })()
  }, [pub])

  async function handleDeposit() {
    if (!keys || !viewKeys || !address || !pub) { toast.error('Unlock your wallet first'); return }
    const atoms = parseUsdc(amount)
    if (atoms <= 0n) { toast.error('Enter an amount'); return }
    if (maxDeposit && atoms > maxDeposit) {
      toast.error(`Max deposit is ${formatUsdc(maxDeposit)} USDC`); return
    }
    if (poolBal !== null && maxPool !== null && poolBal + atoms > maxPool) {
      toast.error(`Pool capacity exceeded`); return
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

      const blinding  = BigInt(Date.now()) * 1_000_003n + BigInt(Math.floor(Math.random() * 1e9))
      const secret    = depositSecret(keys.ownerKey, blinding)
      const memo      = encryptMemo(viewKeys.encPub, { assetId: USDC_ID, amount: atoms, blinding })

      setStep('deposit')
      const depositTx = await writeContractAsync({
        address: POOL_ADDRESS, abi: POOL_ABI, functionName: 'deposit',
        args: [atoms, secret, memo],
        gas: 900_000n,
      })
      await pub.waitForTransactionReceipt({ hash: depositTx })

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

      toast.success(`Deposited ${formatUsdc(atoms)} USDC`)
      setAmount('')
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

  return (
    <div className="flex flex-col gap-4 px-4 pt-4">
      <div className="rounded-2xl bg-[var(--surface-strong)] border border-[var(--border)]
                      backdrop-blur-sm p-5 flex flex-col gap-4">
        <p className="text-xs font-semibold tracking-widest text-[var(--subtle)] uppercase">
          Deposit USDC
        </p>

        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 rounded-xl border border-[var(--border)]
                          bg-[var(--surface-muted)] px-4 h-14">
            <input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="flex-1 bg-transparent text-xl font-display font-600 text-[var(--ink)]
                         outline-none tabular-nums [appearance:textfield]"
            />
            <span className="text-sm font-semibold text-[var(--muted)]">USDC</span>
          </div>
          {capsReady && (
            <p className="text-xs text-[var(--subtle)] px-1">
              Max: {formatUsdc(maxDeposit)} · Pool space: {formatUsdc(remaining!)}
            </p>
          )}
        </div>

        {(overDeposit || overPool) && (
          <div className="flex items-center gap-2 text-[var(--danger)] text-xs px-1">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {overDeposit ? `Exceeds max deposit of ${formatUsdc(maxDeposit)} USDC` : 'Exceeds pool capacity'}
          </div>
        )}

        {busy && (
          <p className="text-xs text-[var(--muted)] text-center">
            {step === 'approve' ? 'Approving USDC…' : step === 'deposit' ? 'Depositing…' : ''}
          </p>
        )}

        <button
          onClick={() => { void handleDeposit() }}
          disabled={busy || !keys || overDeposit || overPool || !amount}
          className="flex items-center justify-center gap-2 h-12 rounded-xl
                     bg-[var(--accent)] text-white text-sm font-semibold
                     hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
        >
          <ArrowDownToLine className="w-4 h-4" />
          {busy ? 'Depositing…' : 'Deposit'}
        </button>
      </div>
    </div>
  )
}
