import type { QueryClient } from '@tanstack/react-query'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'
import { readFlow, readIndex } from '@/lib/flow-status/store'

/**
 * Find the journal entry for a given burn signature, if any. Journal
 * entries are keyed on `flowId`, not signature, so this is an O(N)
 * scan of the index — N is small (≤ a handful of in-flight flows in
 * normal use), so the linear scan is fine.
 *
 * Returns terminal entries too: we want them as the source of truth
 * for the *amount* (the user's typed principal, not the gross burn
 * which includes the bridge fee). The phase pill is suppressed for
 * terminal entries inside `decorateAction`'s phase rule so the
 * Wormholescan "Delivered" badge still wins display precedence.
 */
export function findJournalEntryBySignature(
  qc: QueryClient,
  signature: string,
): PersistedFlowStatus | null {
  const ids = readIndex(qc)
  for (const id of ids) {
    const entry = readFlow(qc, id)
    if (entry !== undefined && entry.signature === signature) {
      return entry
    }
  }
  return null
}

/**
 * Parse a user-typed amount string ("1", "1.5", "0.123456") into raw
 * units. Returns null on invalid input rather than throwing — display
 * code falls back to whatever upstream amount is available if parsing
 * fails. Less strict than `useTransferMutation.parseAmountStrict`
 * because we're consuming already-validated journal data; tolerance
 * for weirdness here is preferable to crashing the row.
 */
export function parseAmountForDisplay(amountStr: string, decimals: number): bigint | null {
  if (!/^\d*(?:\.\d*)?$/.test(amountStr) || amountStr === '') {
    return null
  }
  const [whole, fraction = ''] = amountStr.split('.')
  if (fraction.length > decimals) {
    return null
  }
  const padded = fraction.padEnd(decimals, '0')
  try {
    return BigInt(`${whole || '0'}${padded}`)
  } catch {
    return null
  }
}
