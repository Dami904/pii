/**
 * src/components/UnlockScreen.tsx
 * Landing (wallet not connected) and EIP-712 sign-to-unlock screen. Keys stay in memory.
 */

import { useState }                        from 'react'
import { ConnectKitButton }                from 'connectkit'
import { useAccount, useSignTypedData }    from 'wagmi'
import { toast }                           from 'sonner'
import { EyeOff, Users, Radio }            from 'lucide-react'
import { deriveKeys }                      from '@sdk/keys'
import { deriveViewingKeys }               from '@sdk/memo'
import { usePii }                          from '../contexts/PiiContext.js'
import { CHAIN_ID, EXPLORER, POOL_ADDRESS } from '../lib/pii.js'
import { ACTIVE_CHAIN, IS_MAINNET }        from '../lib/network.js'
import { LogoMark }                        from './Logo.js'

const FEATURES = [
  { Icon: EyeOff, title: 'Private payments',
    body: 'Inside the pool, sender, receiver and amount stay hidden.' },
  { Icon: Users,  title: 'Private payroll',
    body: 'Pay a whole team from a CSV without publishing salaries.' },
  { Icon: Radio,  title: 'Your wallet stays out',
    body: 'A relayer submits payments, so your address never signs them.' },
]

const STEPS = ['Deposit USDC', 'Pay privately', 'Withdraw anywhere']

export default function UnlockScreen() {
  const { address }                  = useAccount()
  const { signTypedDataAsync }       = useSignTypedData()
  const { setKeys }                  = usePii()

  const [unlocking, setUnlocking]    = useState(false)

  async function handleUnlock() {
    if (!address) { toast.error('Connect your wallet first'); return }
    setUnlocking(true)
    try {
      // Always the app's chain: keys must not depend on the wallet's current network.
      const k  = await deriveKeys(signTypedDataAsync, CHAIN_ID)
      const vk = deriveViewingKeys(k.sk)
      setKeys(k, vk)
      toast.success('Pii wallet unlocked')
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Unlock failed')
    } finally {
      setUnlocking(false)
    }
  }

  if (!address) {
    return (
      <div className="flex flex-col items-center gap-7 px-4 pt-6 pb-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <LogoMark size={64} />
          <h1 className="font-display text-3xl font-700 text-[var(--ink)] tracking-tight">Pii</h1>
          <p className="text-[var(--ink-2)] text-base font-medium max-w-xs leading-snug">
            Private USDC payments and payroll on Arc
          </p>
          <p className="text-[var(--muted)] text-sm max-w-xs">
            Pay anyone without putting who, how much or when on a public ledger.
          </p>
        </div>

        <ConnectKitButton.Custom>
          {({ show }) => (
            <button
              onClick={show}
              className="w-full max-w-xs h-12 rounded-xl bg-[var(--accent)] text-white font-semibold text-sm
                         hover:bg-[var(--accent-hover)] transition-colors"
            >
              Connect wallet
            </button>
          )}
        </ConnectKitButton.Custom>

        <div className="pii-card w-full max-w-xs p-4 flex flex-col gap-3">
          <p className="text-[11px] font-semibold tracking-widest text-[var(--subtle)] uppercase">
            What the chain shows
          </p>
          <div className="pii-field px-3 py-2.5">
            <p className="text-[10px] text-[var(--muted)]">Normal USDC transfer</p>
            <p className="font-mono text-xs text-[var(--ink)] mt-0.5">0xA3f1…92c0 → 0x9B27…e4d1</p>
            <p className="font-display text-lg font-700 tabular-nums text-[var(--ink)]">500.00 USDC</p>
          </div>
          <div className="pii-field px-3 py-2.5 bg-[var(--surface-muted)]">
            <p className="text-[10px] text-[var(--muted)]">Pii private payment</p>
            <p className="font-mono text-xs text-[var(--ink)] mt-0.5">•••••• → ••••••</p>
            <p className="font-display text-lg font-700 tabular-nums text-[var(--ink)]">••••• USDC</p>
          </div>
          <p className="text-[10px] text-[var(--subtle)] leading-relaxed">
            Example. The chain only sees a zero-knowledge proof that the payment is valid.
          </p>
        </div>

        <ol className="w-full max-w-xs flex items-start justify-between gap-2 text-center">
          {STEPS.map((label, i) => (
            <li key={label} className="flex-1 flex flex-col items-center gap-1.5">
              <span className="w-6 h-6 rounded-full border border-[var(--border)] bg-[var(--surface)]
                               text-[11px] font-semibold text-[var(--ink-2)] flex items-center justify-center">
                {i + 1}
              </span>
              <span className="text-[11px] text-[var(--muted)] leading-tight">{label}</span>
            </li>
          ))}
        </ol>

        <ul className="w-full max-w-xs flex flex-col gap-3">
          {FEATURES.map(({ Icon, title, body }) => (
            <li key={title}
              className="flex items-start gap-3 rounded-xl bg-[var(--surface)] border border-[var(--border)] px-4 py-3">
              <Icon className="w-4 h-4 mt-0.5 text-[var(--accent)] flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-[var(--ink)]">{title}</p>
                <p className="text-xs text-[var(--muted)] mt-0.5">{body}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="w-full max-w-xs flex flex-col items-center gap-2 text-center">
          <p className="text-[11px] text-[var(--subtle)] leading-relaxed">
            {IS_MAINNET ? 'Mainnet beta' : `${ACTIVE_CHAIN.name} beta`} · 5 USDC per deposit, 50 USDC pool cap ·
            open source (MIT) · not audited
          </p>
          <div className="flex gap-4 text-xs">
            <a href={`${EXPLORER}/address/${POOL_ADDRESS}`} target="_blank" rel="noopener noreferrer"
               className="text-[var(--accent-hover)] hover:underline">Pool contract</a>
            <a href="https://github.com/Dami904/pii" target="_blank" rel="noopener noreferrer"
               className="text-[var(--accent-hover)] hover:underline">How it works</a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 px-4">
      <LogoMark size={64} />
      <div className="text-center">
        <h1 className="font-display text-2xl font-700 text-[var(--ink)] tracking-tight">Unlock Pii</h1>
        <p className="text-[var(--muted)] text-sm mt-1 max-w-xs text-center">
          Sign a message to derive your private keys.<br />
          Keys never leave your browser.
        </p>
      </div>
      <button
        onClick={() => { void handleUnlock() }}
        disabled={unlocking}
        className="w-full max-w-xs h-12 rounded-xl bg-[var(--accent)] text-white font-semibold text-sm
                   hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
      >
        {unlocking ? 'Signing…' : 'Sign to unlock'}
      </button>
    </div>
  )
}
