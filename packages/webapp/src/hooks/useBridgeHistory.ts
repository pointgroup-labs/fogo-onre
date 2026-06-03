'use client'

import type { PublicKey } from '@solana/web3.js'
import type { BridgeAction, DisplayAction } from '@/lib/bridgeHistory/bridgeAction'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { USDC_S_MINT } from '@/constants'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { fetchFogoDeliveryReceipt } from '@/lib/bridgeDelivery/fogoReceipt'
import { actionFromJournal, classifyOpsIntoActions, decorateAction } from '@/lib/bridgeHistory/bridgeAction'
import { useDismissedBridges } from '@/lib/bridgeHistory/dismissed'
import { findJournalEntryBySignature } from '@/lib/bridgeHistory/merge'
import {
  nearestUnusedJournal,
  ORPHAN_MATCH_CLOCK_SKEW_MS,
  ORPHAN_MATCH_WINDOW_MS,
} from '@/lib/bridgeHistory/orphanJournalMatch'
import { fetchAddressOpsPage, WORMHOLESCAN_PAGE_SIZE } from '@/lib/bridgeHistory/wormholescan-list'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

/**
 * History source: Wormholescan `/operations?address=<user>`. Replaces
 * the old FOGO `getSignaturesForAddress` burn-paging pipeline — the
 * public FOGO RPC only retains ~5 days of signatures, so anything
 * older silently disappeared. Wormholescan indexes every NTT VAA
 * permanently, so a single paged call returns the wallet's full
 * cross-chain history.
 *
 * Grouping (one row per logical user intent) happens inside
 * `classifyOpsIntoActions` — withdraw actions pair an outbound ONyc
 * burn with its inbound USDC delivery; deposit actions anchor on the
 * inbound ONyc delivery because the user-signed source burn is
 * paymaster-wrapped and not visible to the address query.
 *
 * Orphan-deposit rows surface with the inbound ONyc amount. The exact
 * deposited USDC is NOT recovered here — that walk is ~3 Solana RPC
 * calls per row, so it's deferred to the tx-detail page
 * (`useDepositUsdcAmount`) for the single opened row. The React-tree
 * useMemo below is a pure projection: journal back-fill, dedup,
 * decoration, synthetic rows.
 */

interface WormholescanPageData {
  actions: BridgeAction[]
  hasMore: boolean
  nextPage: number
}

export interface UseBridgeHistoryResult {
  actions: DisplayAction[]
  isLoading: boolean
  /**
   * True once the underlying history query has completed at least one
   * fetch. Distinct from `!isLoading`: when no owner is connected the
   * query is `enabled: false`, so `isLoading` is `false` even though
   * we've never actually queried — `isFetched` stays `false` in that
   * case, which is what callers need to distinguish "settled empty"
   * from "haven't tried".
   */
  isFetched: boolean
  isError: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
  isFetchingNextPage: boolean
}

export function useBridgeHistory(owner: PublicKey | null): UseBridgeHistoryResult {
  const qc = useQueryClient()
  // Subscribe so dismiss/undismiss actions in this tab (or another)
  // re-merge the action set immediately.
  const dismissed = useDismissedBridges()

  const ownerB58 = owner?.toBase58() ?? null

  const historyQuery = useInfiniteQuery<WormholescanPageData>({
    queryKey: ['bridge-history', 'wormholescan', ownerB58],
    enabled: ownerB58 !== null,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const page = pageParam as number
      const ownerStr = ownerB58 as string
      const { ops, hasMore } = await fetchAddressOpsPage(ownerStr, page)
      // Per-page grouping rather than across all pages: both legs of
      // any single round-trip share a Wormholescan timestamp window
      // of seconds and land on the same page.
      const actions = classifyOpsIntoActions(ops, ownerStr)
      return { actions, hasMore, nextPage: page + 1 }
    },
    getNextPageParam: last => (last.hasMore ? last.nextPage : undefined),
    // 30s balances "show me deliveries quickly" against the cost of
    // refetching N pages on every window focus.
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const indexerActions: BridgeAction[] = useMemo(() => {
    const pages = historyQuery.data?.pages ?? []
    const all = pages.flatMap(p => p.actions)
    // Dedup defensively across pages — Wormholescan paging quirks
    // can't double-render an action.
    const seen = new Set<string>()
    const out: BridgeAction[] = []
    for (const a of all) {
      if (!seen.has(a.anchorSig)) {
        seen.add(a.anchorSig)
        out.push(a)
      }
    }
    return out
  }, [historyQuery.data])

  // Subscribe to the journal index so phase/identity changes re-render
  // before the burn surfaces on Wormholescan.
  const indexQuery = useQuery<string[]>({
    queryKey: ['pending-flow-ids'],
    queryFn: () => [],
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    initialData: [],
  })
  const journalIds = indexQuery.data ?? []

  const flowQueries = useQueries({
    queries: journalIds.map(id => ({
      queryKey: ['flow-status', id],
      queryFn: () => undefined as PersistedFlowStatus | undefined,
      enabled: false,
      staleTime: Infinity,
      gcTime: Infinity,
    })),
  })

  const baseActions: DisplayAction[] = useMemo(() => {
    const journals: PersistedFlowStatus[] = []
    for (const fq of flowQueries) {
      const j = fq.data
      if (j === undefined) {
        continue
      }
      if (ownerB58 !== null && j.ownerB58 !== ownerB58) {
        continue
      }
      journals.push(j)
    }

    // Pass 0: back-fill `originSig` on orphan actions by matching a
    // same-owner, same-kind, in-window journal entry via the shared
    // `nearestUnusedJournal` matcher.
    const usedJournalSigs = new Set<string>()
    const consumed: BridgeAction[] = indexerActions.map((action) => {
      if (action.originSig !== null || action.anchorChain !== 'Solana') {
        return action
      }
      const match = nearestUnusedJournal(journals, action.kind, action.startedAt * 1000, usedJournalSigs)
      if (match === null) {
        if (action.kind === 'deposit' && action.sourceMintB58 !== USDC_S_MINT.toBase58()) {
          console.warn('[bridge-history] orphan deposit unmatched by journal', {
            actionSig: action.anchorSig,
            actionStartedAtMs: action.startedAt * 1000,
            windowMs: ORPHAN_MATCH_WINDOW_MS,
            clockSkewMs: ORPHAN_MATCH_CLOCK_SKEW_MS,
          })
        }
        return action
      }
      usedJournalSigs.add(match.signature)
      // Extend aliases so the detail page resolves journal-sig URLs.
      const aliases = new Set(action.aliases)
      aliases.add(match.signature)
      return { ...action, originSig: match.signature, aliases }
    })

    // Pass 0.5: collapse canonical actions sharing an `originSig`.
    const deduped: BridgeAction[] = dedupByOriginSig(consumed)

    // Pass 1: apply journal precedence via the display decorator.
    const decorated: DisplayAction[] = deduped.map((action) => {
      const lookupSig = action.originSig ?? action.anchorSig
      const journal = findJournalEntryBySignature(qc, lookupSig)
      return decorateAction(action, journal, dismissed)
    })

    // Pass 2: synthesize optimistic actions for journal entries whose
    // burn hasn't yet surfaced on Wormholescan.
    const knownSigs = new Set<string>()
    for (const a of decorated) {
      knownSigs.add(a.anchorSig)
      if (a.originSig !== null) {
        knownSigs.add(a.originSig)
      }
    }
    const synthetic: DisplayAction[] = []
    for (const j of journals) {
      if (knownSigs.has(j.signature)) {
        continue
      }
      synthetic.push(decorateAction(actionFromJournal(j), j, dismissed))
    }

    return [...synthetic, ...decorated].sort((a, b) => b.startedAt - a.startedAt)
  }, [indexerActions, qc, flowQueries, ownerB58, dismissed])

  // Wormholescan-independent delivery overlay. Wormholescan never indexes
  // OnRe's custom relayer-CPI redeem, and a cross-device / cold-link row
  // has no `terminal-success` journal — so without this a delivered row
  // sits on "Pending"/"Unconfirmed" forever. We scan the destination ATA
  // (per row, keyed on its own `startedAt`) with the same false-positive-
  // impossible oracle the detail page uses. Only rows not already
  // confirmed are scanned, bounding RPC cost to the genuinely-open set.
  const { fogoRpcUrl } = useSettings()
  const visible = useDocumentVisible()
  const candidates = useMemo(
    () => baseActions.filter(
      a => !(a.status === 'delivered' || a.manuallyDismissed || a.journalDelivered),
    ),
    [baseActions],
  )
  const deliveryQueries = useQueries({
    queries: candidates.map(a => ({
      queryKey: ['fogo-delivery-row', a.anchorSig, a.kind, ownerB58, fogoRpcUrl] as const,
      enabled: owner !== null,
      refetchOnWindowFocus: false,
      refetchInterval: (q: { state: { data?: { kind: string } } }) =>
        (q.state.data?.kind === 'delivered' ? false : visible ? 30_000 : false),
      staleTime: (q: { state: { data?: { kind: string } } }) =>
        (q.state.data?.kind === 'delivered' ? Infinity : 30_000),
      queryFn: () => fetchFogoDeliveryReceipt(getFogoConnection(fogoRpcUrl), {
        owner: owner as PublicKey,
        kind: a.kind,
        sourceBlockTime: a.startedAt,
      }),
    })),
  })

  // Stable string key so `actions` only recomputes when the *set* of
  // chain-confirmed rows changes, not on every `useQueries` array identity.
  const chainDeliveredKey = candidates
    .map((a, i) => (deliveryQueries[i]?.data?.kind === 'delivered' ? a.anchorSig : ''))
    .filter(Boolean)
    .join(',')

  const actions = useMemo(() => {
    const delivered = new Set(chainDeliveredKey === '' ? [] : chainDeliveredKey.split(','))
    if (delivered.size === 0) {
      return baseActions
    }
    return baseActions.map(a => (delivered.has(a.anchorSig) ? { ...a, chainDelivered: true } : a))
  }, [baseActions, chainDeliveredKey])

  return {
    actions,
    isLoading: historyQuery.isLoading,
    isFetched: historyQuery.isFetched,
    isError: historyQuery.isError,
    hasNextPage: historyQuery.hasNextPage ?? false,
    fetchNextPage: () => { historyQuery.fetchNextPage() },
    isFetchingNextPage: historyQuery.isFetchingNextPage,
  }
}

function dedupByOriginSig(actions: BridgeAction[]): BridgeAction[] {
  const byOrigin = new Map<string, BridgeAction>()
  const out: BridgeAction[] = []
  for (const action of actions) {
    const key = action.originSig
    if (key === null) {
      out.push(action)
      continue
    }
    const prev = byOrigin.get(key)
    if (prev === undefined) {
      byOrigin.set(key, action)
      out.push(action)
      continue
    }
    if (prefer(action, prev)) {
      const idx = out.indexOf(prev)
      if (idx !== -1) {
        out[idx] = action
      }
      byOrigin.set(key, action)
    }
  }
  return out
}

function prefer(candidate: BridgeAction, incumbent: BridgeAction): boolean {
  const score = (a: BridgeAction) =>
    (a.status === 'delivered' ? 2 : 0) + (a.finalSig !== null ? 1 : 0)
  return score(candidate) > score(incumbent)
}

export { WORMHOLESCAN_PAGE_SIZE }
