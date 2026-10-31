/**
 * src/components/ui.tsx
 * Small shared pieces so Deposit, Pay and Withdraw look like one product.
 */

import type { ReactNode } from 'react'

export function TokenPill({ token = 'USDC' }: { token?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--border-strong)]
                     bg-white text-sm font-semibold text-[var(--ink)] flex-shrink-0">
      <span className="w-4 h-4 rounded-full bg-[#2775ca] text-white text-[9px] leading-4 text-center font-bold">$</span>
      {token}
    </span>
  )
}

export interface Chip { label: string; value: string }

/**
 * An amount field: a labelled input with a token pill, optionally a second read-only row
 * (what the other side receives), a hint, and quick-amount chips.
 */
export function AmountBox(props: {
  label:         string
  value:         string
  onChange:      (v: string) => void
  resultLabel?:  string
  resultValue?:  string
  hint?:         ReactNode
  chips?:        Chip[]
}) {
  const { label, value, onChange, resultLabel, resultValue, hint, chips } = props
  return (
    <div className="flex flex-col gap-2">
      <div className="pii-field overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <label className="flex-1 min-w-0 block">
            <span className="block text-[11px] text-[var(--muted)]">{label}</span>
            <input
              type="number"
              inputMode="decimal"
              placeholder="0.00"
              value={value}
              onChange={e => onChange(e.target.value)}
              className="w-full bg-transparent text-2xl font-display font-700 text-[var(--ink)]
                         outline-none tabular-nums [appearance:textfield]"
            />
          </label>
          <TokenPill />
        </div>
        {resultLabel !== undefined && (
          <div className="flex items-center gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--surface-muted)]">
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-[var(--muted)]">{resultLabel}</p>
              <p className="text-2xl font-display font-700 tabular-nums text-[var(--ink-2)] truncate">
                {resultValue ?? '0.00'}
              </p>
            </div>
            <TokenPill />
          </div>
        )}
      </div>
      {hint && <p className="text-[11px] text-[var(--subtle)] px-1 leading-relaxed">{hint}</p>}
      {chips && chips.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {chips.map(c => (
            <button key={c.label} type="button" className="pii-chip" onClick={() => onChange(c.value)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** One muted line under a primary button: fee, network, time. */
export function Summary({ children }: { children: ReactNode }) {
  return <p className="text-[11px] text-[var(--subtle)] text-center">{children}</p>
}

/** Placeholder bar shown while data loads. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded-lg bg-[var(--surface-muted)] ${className}`} />
}
