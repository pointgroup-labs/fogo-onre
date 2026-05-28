import type { BridgeAction } from './bridgeAction'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'

/**
 * Orphan-deposit ↔ journal matching.
 *
 * Paymaster-wrapped FOGO USDC burns never surface under the user's
 * address on Wormholescan, so a deposit arrives Solana-anchored with an
 * ONyc-denominated source amount and no `originSig`. When the deposit
 * was made on this device, a same-owner journal entry carries the real
 * USDC principal and the user-signed burn sig. `useBridgeHistory`'s
 * render-time Pass 0 uses `nearestUnusedJournal` to back-fill that
 * `originSig` (and overlay the USDC amount via `decorateAction`).
 *
 * The exact USDC for *cross-device* orphans — where no journal exists —
 * is recovered on demand from the relayer's Solana events by
 * `useDepositUsdcAmount`, only when the row is opened on the tx-detail
 * page. This module is journal-only; it does no I/O.
 */

/** Negative bound tolerates browser↔indexer clock skew; we've seen tens of seconds in the wild. */
export const ORPHAN_MATCH_CLOCK_SKEW_MS = 60_000
export const ORPHAN_MATCH_WINDOW_MS = 24 * 60 * 60 * 1_000

/**
 * Nearest unused journal entry of the right kind within the orphan-
 * matching window. The `used` set is the caller's bookkeeping —
 * callers thread the same set across multiple actions so two orphans
 * never claim the same journal.
 */
export function nearestUnusedJournal(
  journals: PersistedFlowStatus[],
  kind: BridgeAction['kind'],
  actionMs: number,
  used: ReadonlySet<string>,
): PersistedFlowStatus | null {
  let best: PersistedFlowStatus | null = null
  let bestDist = Infinity
  for (const j of journals) {
    if (used.has(j.signature) || j.kind !== kind) {
      continue
    }
    const delta = actionMs - j.startedAt
    if (delta < -ORPHAN_MATCH_CLOCK_SKEW_MS || delta > ORPHAN_MATCH_WINDOW_MS) {
      continue
    }
    const dist = Math.abs(delta)
    if (dist < bestDist) {
      best = j
      bestDist = dist
    }
  }
  return best
}
