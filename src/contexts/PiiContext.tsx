/**
 * src/contexts/PiiContext.tsx
 * Holds the user's Pii keys (memory-only) and synced wallet state.
 */

import { createContext, useContext, useRef, useState, useCallback, type ReactNode } from 'react'
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
  /** Label of the transaction in progress (null when idle). While set, navigation is locked. */
  busyLabel:   string | null
  /** Mark a transaction as in progress; call the returned function when it ends. */
  startTask:   (label: string) => () => void
}

const Ctx = createContext<PiiCtx | null>(null)

export function PiiProvider({ children }: { children: ReactNode }) {
  const [keys,     setKeysState]   = useState<PiiKeys | null>(null)
  const [viewKeys, setViewKeysState] = useState<ViewingKeys | null>(null)
  const [wallet,   setWalletState] = useState<PiiWallet | null>(null)
  const [tasks,    setTasks]       = useState<{ id: number; label: string }[]>([])
  const nextTask = useRef(0)

  const startTask = useCallback((label: string) => {
    const id = nextTask.current++
    setTasks(t => [...t, { id, label }])
    return () => setTasks(t => t.filter(x => x.id !== id))
  }, [])

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
    <Ctx.Provider value={{ keys, viewKeys, wallet, setKeys, setWallet: setWalletState, clearKeys, busyLabel: tasks[0]?.label ?? null, startTask }}>
      {children}
    </Ctx.Provider>
  )
}

export function usePii() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('usePii must be used inside PiiProvider')
  return ctx
}
