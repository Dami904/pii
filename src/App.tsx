/**
 * src/App.tsx
 * Pii — private payments on Arc.
 */

import { useState, useEffect }         from 'react'
import { ConnectKitButton }            from 'connectkit'
import { toast }                       from 'sonner'
import { useAccount, useSwitchChain }  from 'wagmi'
import { Wallet, ArrowDownToLine, Send, Users, ArrowUpFromLine } from 'lucide-react'
import { LogoMark }                     from './components/Logo.js'
import { IS_MAINNET, ACTIVE_CHAIN, MAINNET_SITE, TESTNET_SITE } from './lib/network.js'
import { PiiProvider, usePii }         from './contexts/PiiContext.js'
import UnlockScreen                    from './components/UnlockScreen.js'
import Portfolio                       from './components/Portfolio.js'
import DepositTab                      from './components/DepositTab.js'
import PayTab                          from './components/PayTab.js'
import PayrollTab                      from './components/PayrollTab.js'
import WithdrawTab                     from './components/WithdrawTab.js'

type Tab = 'portfolio' | 'deposit' | 'pay' | 'payroll' | 'withdraw'

const TABS: { id: Tab; label: string; Icon: React.FC<{ className?: string }> }[] = [
  { id: 'portfolio', label: 'Portfolio', Icon: Wallet },
  { id: 'deposit',   label: 'Deposit',   Icon: ArrowDownToLine },
  { id: 'pay',       label: 'Pay',       Icon: Send },
  { id: 'payroll',   label: 'Payroll',   Icon: Users },
  { id: 'withdraw',  label: 'Withdraw',  Icon: ArrowUpFromLine },
]

function AppInner() {
  const { isConnected, address, chainId } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const { keys, clearKeys, busyLabel } = usePii()
  const [tab, setTab]    = useState<Tab>('portfolio')

  // Keys are derived per account and per chain: lock on any change of either.
  useEffect(() => { clearKeys() }, [address, chainId, clearKeys])

  // While a transaction runs, leaving the page would orphan it (and Payroll would lose its
  // progress, inviting a double payment). Ask the browser to confirm before it closes.
  useEffect(() => {
    if (!busyLabel) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busyLabel])

  const wrongChain = isConnected && chainId !== ACTIVE_CHAIN.id
  const unlocked = isConnected && !wrongChain && keys !== null

  return (
    <div className="app-stage min-h-dvh flex flex-col items-center" style={{ background: 'var(--bg-gradient)' }}>
     {/* On laptop screens the app sits inside a rounded card; on phones it is full screen. */}
     <div className="app-frame w-full flex-1 flex flex-col">
      <div className="app-scroll w-full flex-1 flex flex-col items-center">
      {/* Network banner */}
      {IS_MAINNET ? (
        <div className="w-full bg-orange-50 border-b border-orange-200 py-1.5 px-4 text-center">
          <p className="text-xs text-orange-800 font-medium">
            Mainnet beta · small caps (5 USDC per deposit) · anonymity set is small
            {' · '}
            <a href={TESTNET_SITE} className="underline font-semibold">Try the testnet</a>
          </p>
        </div>
      ) : (
        <div className="w-full bg-amber-50 border-b border-amber-200 py-1.5 px-4 text-center">
          <p className="text-xs text-amber-800">
            Testnet · anonymity set is small; privacy grows with users.
            {' · '}
            <a href={MAINNET_SITE} className="underline font-semibold">Go to mainnet</a>
          </p>
        </div>
      )}

      {/* Header */}
      <header className="w-full app-col px-4 pt-5 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LogoMark size={32} />
          <span className="font-display text-lg font-700 text-[var(--ink)] tracking-tight">Pii</span>
        </div>
        <ConnectKitButton />
      </header>

      {/* Wrong network: block unlock and every action until the wallet is on Arc */}
      {wrongChain && (
        <main className="w-full app-col flex-1 px-4">
          <div className="flex flex-col items-center justify-center min-h-[60vh] gap-5 text-center">
            <h1 className="font-display text-2xl font-700 text-[var(--ink)] tracking-tight">
              Switch to {ACTIVE_CHAIN.name}
            </h1>
            <p className="text-[var(--muted)] text-sm max-w-xs">
              Pii runs on {ACTIVE_CHAIN.name}. Your private keys depend on the network,
              so unlocking or depositing on another network would hide your balance.
            </p>
            <button
              onClick={() => switchChain({ chainId: ACTIVE_CHAIN.id })}
              disabled={switching}
              className="w-full max-w-xs h-12 rounded-xl bg-[var(--accent)] text-white font-semibold text-sm
                         hover:bg-[var(--accent-hover)] disabled:opacity-50 transition-colors"
            >
              {switching ? 'Switching…' : `Switch to ${ACTIVE_CHAIN.name}`}
            </button>
          </div>
        </main>
      )}

      {/* Unlock gate — shown when connected but not unlocked */}
      {isConnected && !wrongChain && !keys && (
        <main className="w-full app-col flex-1">
          <UnlockScreen />
        </main>
      )}

      {/* Not connected */}
      {!isConnected && (
        <main className="w-full app-col flex-1">
          <UnlockScreen />
        </main>
      )}

      {/* Main app — shown only when unlocked */}
      {unlocked && (
        <main className="w-full app-col flex-1 pb-24">
          {tab === 'portfolio' && <Portfolio />}
          {tab === 'deposit'   && <DepositTab />}
          {tab === 'pay'       && <PayTab />}
          {tab === 'payroll'   && <PayrollTab />}
          {tab === 'withdraw'  && <WithdrawTab />}
        </main>
      )}

      </div>

      {/* Bottom nav — only when unlocked */}
      {unlocked && (
        <nav className="fixed bottom-0 left-0 right-0 flex justify-center pb-safe">
          {busyLabel && (
            <div className="absolute -top-9 left-0 right-0 flex justify-center pointer-events-none">
              <span className="px-3 py-1.5 rounded-full bg-[var(--accent)] text-white text-[11px] font-semibold shadow">
                {busyLabel} in progress · stay on this page
              </span>
            </div>
          )}
          <div className="w-full app-col bg-[var(--surface-strong)] border-t border-[var(--border)]
                          backdrop-blur-xl flex">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => {
                  if (busyLabel && id !== tab) {
                    toast.error(`${busyLabel} in progress. Wait for it to finish before leaving this page.`)
                    return
                  }
                  setTab(id)
                }}
                className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-semibold
                            tracking-wide uppercase transition-colors
                            ${tab === id
                              ? 'text-[var(--accent)]'
                              : 'text-[var(--subtle)] hover:text-[var(--ink-2)]'}
                            ${busyLabel && tab !== id ? 'opacity-40' : ''}`}
              >
                <Icon className="w-5 h-5" />
                {label}
              </button>
            ))}
          </div>
        </nav>
      )}
     </div>
    </div>
  )
}

export default function App() {
  return (
    <PiiProvider>
      <AppInner />
    </PiiProvider>
  )
}
