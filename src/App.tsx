/**
 * src/App.tsx
 * Pii — private payments on Arc Testnet.
 */

import { useState }                    from 'react'
import { ConnectKitButton }            from 'connectkit'
import { useAccount }                  from 'wagmi'
import { Shield, Wallet, ArrowDownToLine, Send, Users, ArrowUpFromLine } from 'lucide-react'
import { IS_MAINNET }                   from './lib/network.js'
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
  const { isConnected }  = useAccount()
  const { keys }         = usePii()
  const [tab, setTab]    = useState<Tab>('portfolio')

  const unlocked = isConnected && keys !== null

  return (
    <div className="min-h-dvh flex flex-col items-center" style={{ background: 'var(--bg-gradient)' }}>
      {/* Network banner */}
      {IS_MAINNET ? (
        <div className="w-full bg-orange-50 border-b border-orange-200 py-1.5 px-4 text-center">
          <p className="text-xs text-orange-800 font-medium">
            Mainnet beta · small caps (5 USDC per deposit) · anonymity set is small
          </p>
        </div>
      ) : (
        <div className="w-full bg-amber-50 border-b border-amber-200 py-1.5 px-4 text-center">
          <p className="text-xs text-amber-800">
            Testnet · anonymity set is small; privacy grows with users.
          </p>
        </div>
      )}

      {/* Header */}
      <header className="w-full max-w-md px-4 pt-5 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-[var(--accent)] flex items-center justify-center">
            <Shield className="w-4 h-4 text-white" />
          </div>
          <span className="font-display text-lg font-700 text-[var(--ink)] tracking-tight">Pii</span>
        </div>
        <ConnectKitButton />
      </header>

      {/* Unlock gate — shown when connected but not unlocked */}
      {isConnected && !keys && (
        <main className="w-full max-w-md flex-1">
          <UnlockScreen />
        </main>
      )}

      {/* Not connected */}
      {!isConnected && (
        <main className="w-full max-w-md flex-1">
          <UnlockScreen />
        </main>
      )}

      {/* Main app — shown only when unlocked */}
      {unlocked && (
        <main className="w-full max-w-md flex-1 pb-24">
          {tab === 'portfolio' && <Portfolio />}
          {tab === 'deposit'   && <DepositTab />}
          {tab === 'pay'       && <PayTab />}
          {tab === 'payroll'   && <PayrollTab />}
          {tab === 'withdraw'  && <WithdrawTab />}
        </main>
      )}

      {/* Bottom nav — only when unlocked */}
      {unlocked && (
        <nav className="fixed bottom-0 left-0 right-0 flex justify-center pb-safe">
          <div className="w-full max-w-md bg-[var(--surface-strong)] border-t border-[var(--border)]
                          backdrop-blur-xl flex">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`flex-1 flex flex-col items-center gap-1 py-3 text-[10px] font-semibold
                            tracking-wide uppercase transition-colors
                            ${tab === id
                              ? 'text-[var(--accent)]'
                              : 'text-[var(--subtle)] hover:text-[var(--ink-2)]'}`}
              >
                <Icon className="w-5 h-5" />
                {label}
              </button>
            ))}
          </div>
        </nav>
      )}
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
