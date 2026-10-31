/**
 * src/lib/activity.ts
 * Local activity log (deposits, payments, payroll rows, withdrawals).
 *
 * Outgoing payments are encrypted to the recipient, so the chain cannot tell us who we
 * paid. What this device sends is therefore logged here, in this browser only, per account
 * and network. Payments RECEIVED are rebuilt from the chain (see received.ts) and added
 * once. Entries hold type, amount, time, a counterparty label and a tx hash. Never keys.
 */

import { CHAIN_ID } from './pii.js'

export type ActivityKind = 'deposit' | 'feenote' | 'pay' | 'payroll' | 'withdraw' | 'receive'

export interface ActivityItem {
  id:            string
  kind:          ActivityKind
  /** USDC atoms, as a decimal string (JSON has no bigint). */
  amount:        string
  /** Recipient: a Pii address or 0x address. Shown shortened. */
  counterparty?: string
  txHash?:       string
  /** Unix ms. */
  at:            number
}

const MAX_ITEMS = 200

const storageKey = (ownerKey: bigint) => `pii:activity:v1:${CHAIN_ID}:${ownerKey.toString(16)}`

export function loadActivity(ownerKey: bigint): ActivityItem[] {
  try {
    const raw = localStorage.getItem(storageKey(ownerKey))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as ActivityItem[]).sort((a, b) => b.at - a.at) : []
  } catch {
    return []
  }
}

/** Never throws: a logging failure must not affect a payment. */
export function addActivity(
  ownerKey: bigint,
  item: Omit<ActivityItem, 'id' | 'at' | 'amount'> & { amount: bigint },
): void {
  try {
    const entry: ActivityItem = {
      ...item,
      amount: item.amount.toString(),
      id:     `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at:     Date.now(),
    }
    const next = [entry, ...loadActivity(ownerKey)].slice(0, MAX_ITEMS)
    localStorage.setItem(storageKey(ownerKey), JSON.stringify(next))
  } catch { /* storage unavailable or full */ }
}

/** Add an entry with a fixed id (and time) once; later calls with the same id are ignored. */
export function addActivityOnce(
  ownerKey: bigint,
  id: string,
  item: Omit<ActivityItem, 'id' | 'amount'> & { amount: bigint },
): boolean {
  try {
    const all = loadActivity(ownerKey)
    if (all.some((a) => a.id === id)) return false
    const entry: ActivityItem = { ...item, amount: item.amount.toString(), id }
    localStorage.setItem(storageKey(ownerKey), JSON.stringify([entry, ...all].slice(0, MAX_ITEMS)))
    return true
  } catch {
    return false
  }
}

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  deposit:  'Deposit',
  feenote:  'Fee note',
  pay:      'Payment sent',
  payroll:  'Payroll payment',
  withdraw: 'Withdrawal',
  receive:  'Payment received',
}

export function shortAddr(a: string): string {
  return a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a
}
