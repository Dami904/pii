/**
 * src/contexts/PiiContext.tsx
 * Holds the user's Pii keys (memory-only) and synced wallet state.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { PiiKeys }     from '@sdk/keys'
import type { SyncResult }  from '@sdk/tree'
import type { Note }        from '@sdk/note'
import type { ViewingKeys } from '@sdk/memo'

export interface PiiWallet {
  syncResult: SyncResult
  notes: Note[]           // unspent notes
  totalBalance: bigint
}

interface PiiCtx {
  keys:        PiiKeys | null
  viewKeys:    ViewingKeys | null
  wallet:      PiiWallet | null
  setKeys:     (k: PiiKeys, vk: ViewingKeys) => void
  setWallet:   (w: PiiWallet) => void
  clearKeys:   () => void
}

const Ctx = createContext<PiiCtx | null>(null)

export function PiiProvider({ children }: { children: ReactNode }) {
  const [keys,     setKeysState]   = useState<PiiKeys | null>(null)
  const [viewKeys, setViewKeysState] = useState<ViewingKeys | null>(null)
  const [wallet,   setWalletState] = useState<PiiWallet | null>(null)

  const setKeys = useCallback((k: PiiKeys, vk: ViewingKeys) => {
    setKeysState(k)
    setViewKeysState(vk)
  }, [])

  const clearKeys = useCallback(() => {
    setKeysState(null)
    setViewKeysState(null)
    setWalletState(null)
  }, [])

  return (
    <Ctx.Provider value={{ keys, viewKeys, wallet, setKeys, setWallet: setWalletState, clearKeys }}>
      {children}
    </Ctx.Provider>
  )
}

export function usePii() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePii must be used inside PiiProvider')
  return ctx
}
