/**
 * src/lib/payroll-csv.ts
 * Payroll CSV: one payment per line, `pii_address,amount` (USDC).
 */

import { decodePiiAddress, type PiiNetwork } from '@sdk/memo'
import { parseUsdc } from './pii.js'

export interface CsvRow {
  piiAddress: string
  amount:     bigint
  rawAmount:  string
  error?:     string
  /** An old address with no network marker: accepted, but worth a warning. */
  legacy?:    boolean
}

/**
 * Tolerant of what spreadsheets produce: a UTF-8 BOM, Windows line endings, quoted cells,
 * and the `;` separator with a decimal comma that Excel writes in many locales.
 * A header line and lines starting with # are ignored.
 */
export function parseCSV(text: string, network?: PiiNetwork): CsvRow[] {
  return text.replace(/^﻿/, '').split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.toLowerCase().startsWith('pii_address') && !l.startsWith('#'))
    .map(l => {
      const semicolons = l.includes(';')
      const cells = (semicolons ? l.split(';') : l.split(',')).map(s => s.trim().replace(/^"|"$/g, ''))
      const addr = cells[0]
      const amt  = semicolons && cells[1] ? cells[1].replace(',', '.') : cells[1]
      if (!addr || !amt) return { piiAddress: l, amount: 0n, rawAmount: '', error: 'Bad row' }
      let legacy = false
      try {
        const d = decodePiiAddress(addr)
        // An address made for the other network would send money to keys nobody holds here.
        if (network && d.network && d.network !== network) {
          return { piiAddress: addr, amount: 0n, rawAmount: amt, error: `Wrong network (${d.network} address)` }
        }
        legacy = d.network === undefined
      } catch { return { piiAddress: addr, amount: 0n, rawAmount: amt, error: 'Invalid pii address' } }
      const amount = parseUsdc(amt)
      if (amount <= 0n) return { piiAddress: addr, amount: 0n, rawAmount: amt, error: 'Invalid amount' }
      return { piiAddress: addr, amount, rawAmount: amt, ...(legacy ? { legacy: true } : {}) }
    })
}

/** A starter file. The example rows use the downloader's own address, so it works as a test. */
export function buildSampleCsv(piiAddress: string): string {
  return [
    '# Pii payroll: one payment per line, as pii_address,amount',
    '# Amounts are in USDC (up to 6 decimals). Lines starting with # are ignored.',
    '# Replace the example rows with your team. Each person copies their Pii address from Portfolio.',
    'pii_address,amount',
    `${piiAddress},0.10`,
    `${piiAddress},0.05`,
    '',
  ].join('\n')
}
