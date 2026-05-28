import type { QueryClient } from '@tanstack/react-query'
import type { BridgeAction } from './bridgeAction'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'
import { USDC_S_MINT } from '@/constants'
import { getSolanaConnection } from '@/utils/connections'
import { fetchDepositUsdcAmount } from './depositUsdcAmount'

/**
 * Orphan-deposit USDC recovery boundary.
 *
 * Background: paymaster-wrapped FOGO USDC burns never surface under the
 * user's address on Wormholescan, so deposit actions arrive Solana-
 * anchored with an ONyc-denominated source amount. We resolve the
 * actual USDC the user deposited by walking the relayer's
 * `UsdcClaimed` event on Solana (see `depositUsdcAmount.ts`).
 *
 * This module exists so the recovery is a single, named seam:
 *   - `resolveDepositActions` — call site for `useBridgeHistory`'s
 *     queryFn. Returns a new array with USDC-resolved orphans
 *     re-stamped, others passed through. No in-place mutation.
 *   - `readSameOwnerJournals` + `nearestUnusedJournal` — shared
 *     matchers used by both the queryFn (to skip recovery when a
 *     journal will overlay anyway) and the React-tree Pass 0
 *     (to back-fill `originSig` for the renderer). Same matcher,
 *     two epochs (fetch-time vs render-time), one source of truth.
 */

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
/** Negative bound tolerates browser↔indexer clock skew; we've seen tens of seconds in the wild. */
export const ORPHAN_MATCH_CLOCK_SKEW_MS = 60_000
export const ORPHAN_MATCH_WINDOW_MS = 24 * 60 * 60 * 1_000
/**
 * Cap on in-flight USDC-recovery walks per page fetch. Each recovery
 * is ~3 sequential Solana RPC calls; firing them in parallel against
 * a shared/free-tier RPC trivially trips 429s.
 */
const RECOVERY_CONCURRENCY = 2

export interface ResolveDepositsDeps {
  qc: QueryClient
  solanaRpcUrl: string
  ownerB58: string
}

/**
 * Resolve orphan-deposit USDC amounts for a batch of actions. Pure-ish:
 * does I/O via the injected deps but never mutates its `actions` input.
 *
 * Two-stage cost optimization:
 *   1. Skip orphans with a plausible same-device journal entry —
 *      `decorateAction` will overlay the journal USDC anyway, so the
 *      RPC walk would be wasted. Same-device users pay 0 calls.
 *   2. Bounded concurrency + persisted per-(rpc, sig) cache, so the
 *      remaining cross-device orphans pay 3 calls once, ever.
 */
export async function resolveDepositActions(
  actions: readonly BridgeAction[],
  deps: ResolveDepositsDeps,
): Promise<BridgeAction[]> {
  const { qc, solanaRpcUrl, ownerB58 } = deps
  const journals = readSameOwnerJournals(qc, ownerB58)
  const usedJournalSigs = new Set<string>()

  const recoveredAmounts = new Map<string, bigint>()
  const tasks: Array<() => Promise<void>> = []

  for (const a of actions) {
    if (a.kind !== 'deposit' || a.anchorChain !== 'Solana') {
      continue
    }
    const match = nearestUnusedJournal(journals, a.kind, a.startedAt * 1000, usedJournalSigs)
    if (match !== null) {
      usedJournalSigs.add(match.signature)
      continue
    }
    tasks.push(async () => {
      const resolved = await qc.fetchQuery<string | null>({
        queryKey: ['deposit-usdc-amount', solanaRpcUrl, a.anchorSig],
        queryFn: async () => {
          const conn = getSolanaConnection(solanaRpcUrl)
          const amount = await fetchDepositUsdcAmount({ connection: conn }, a.anchorSig)
          return amount === null ? null : amount.toString()
        },
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: THIRTY_DAYS_MS,
        // `withRetry` inside `fetchDepositUsdcAmount` already handles
        // 429s; composing with React Query's default `retry: 2` would
        // turn a persistent throttle into ~12 RPC hits per failing call.
        retry: false,
      })
      if (resolved !== null) {
        recoveredAmounts.set(a.anchorSig, BigInt(resolved))
      }
    })
  }

  await runWithConcurrency(tasks, RECOVERY_CONCURRENCY)

  if (recoveredAmounts.size === 0) {
    return [...actions]
  }
  const usdcMint = USDC_S_MINT.toBase58()
  return actions.map((a) => {
    const amount = recoveredAmounts.get(a.anchorSig)
    if (amount === undefined) {
      return a
    }
    return { ...a, sourceAmountRaw: amount, sourceMintB58: usdcMint }
  })
}

/**
 * Read same-owner journal entries from the QueryClient cache. Mirrors
 * the React-side `useQueries` subscription but imperatively, because
 * the queryFn runs outside React. Stale reads are bounded: Pass 0
 * re-runs at render time with the live data, so a journal landing
 * mid-fetch still wins the overlay — we only lose the chance to
 * skip recovery for that particular page fetch.
 */
export function readSameOwnerJournals(qc: QueryClient, ownerB58: string): PersistedFlowStatus[] {
  const ids = qc.getQueryData<string[]>(['pending-flow-ids']) ?? []
  const out: PersistedFlowStatus[] = []
  for (const id of ids) {
    const j = qc.getQueryData<PersistedFlowStatus>(['flow-status', id])
    if (j && j.ownerB58 === ownerB58) {
      out.push(j)
    }
  }
  return out
}

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

async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= tasks.length) {
        return
      }
      try {
        await tasks[i]!()
      } catch {
        // Per-task degrade — caller decides the fallback (here, the
        // unresolved orphan keeps its Wormholescan ONyc amount).
      }
    }
  })
  await Promise.all(workers)
}
