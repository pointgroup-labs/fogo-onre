'use client'

import type { PublicKey } from '@solana/web3.js'
import type { BurnRow, OperationStatus, TimelineRow } from '@/lib/bridgeHistory/types'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { findJournalEntryBySignature, mergeRow, rowFromJournal } from '@/lib/bridgeHistory/merge'
import { fetchBurnPage, getCanonicalAtas } from '@/lib/bridgeHistory/rpc'
import { fetchOperationStatus } from '@/lib/bridgeHistory/wormholescan'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'
import { useBridgeFee } from './useBridgeFee'

interface BurnPageGroup {
  cursors: { usdcS: string | undefined, onyc: string | undefined }
  rows: BurnRow[]
  hasMoreUsdcS: boolean
  hasMoreOnyc: boolean
}

export interface UseBridgeHistoryResult {
  rows: TimelineRow[]
  isLoading: boolean
  isError: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
  isFetchingNextPage: boolean
}

export function useBridgeHistory(owner: PublicKey | null): UseBridgeHistoryResult {
  const { fogoRpcUrl } = useSettings()
  const qc = useQueryClient()
  const { feeRaw } = useBridgeFee()

  const ownerB58 = owner?.toBase58() ?? null

  // Page 1: fetch both ATA streams in parallel; merge sorted desc.
  // Subsequent pages advance whichever ATA still has older signatures.
  const burnQuery = useInfiniteQuery<BurnPageGroup>({
    queryKey: ['bridge-history', 'burns', ownerB58, fogoRpcUrl],
    enabled: ownerB58 !== null,
    initialPageParam: { usdcS: undefined, onyc: undefined } as { usdcS: string | undefined, onyc: string | undefined },
    queryFn: async ({ pageParam }) => {
      // owner is guaranteed by `enabled` gate above
      const ownerKey = owner as PublicKey
      const connection = getFogoConnection(fogoRpcUrl)
      const [usdcSBinding, onycBinding] = getCanonicalAtas(ownerKey)
      const cursors = pageParam as { usdcS: string | undefined, onyc: string | undefined }
      const [usdcSPage, onycPage] = await Promise.all([
        fetchBurnPage(connection, usdcSBinding, cursors.usdcS),
        fetchBurnPage(connection, onycBinding, cursors.onyc),
      ])
      const merged = [...usdcSPage.rows, ...onycPage.rows].sort((a, b) => b.blockTime - a.blockTime)
      return {
        cursors: { usdcS: usdcSPage.nextCursor ?? undefined, onyc: onycPage.nextCursor ?? undefined },
        rows: merged,
        hasMoreUsdcS: usdcSPage.nextCursor !== null,
        hasMoreOnyc: onycPage.nextCursor !== null,
      }
    },
    getNextPageParam: (last) => {
      if (!last.hasMoreUsdcS && !last.hasMoreOnyc) {
        return undefined
      }
      return last.cursors
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const allBurns: BurnRow[] = useMemo(() => {
    const pages = burnQuery.data?.pages ?? []
    const all = pages.flatMap(p => p.rows)
    // Dedup by signature defensively (same tx could touch both ATAs)
    const seen = new Set<string>()
    const out: BurnRow[] = []
    for (const r of all) {
      if (!seen.has(r.signature)) {
        seen.add(r.signature)
        out.push(r)
      }
    }
    return out.sort((a, b) => b.blockTime - a.blockTime)
  }, [burnQuery.data])

  // One Wormholescan query per burn. TanStack dedupes parallel calls
  // for the same key. Per-state staleTime: delivered=Infinity, pending=30s,
  // unknown=10s with backoff.
  const opQueries = useQueries({
    queries: allBurns.map(burn => ({
      queryKey: ['wormholescan-op', burn.signature],
      queryFn: () => fetchOperationStatus(burn.signature),
      staleTime: (q: { state: { data?: OperationStatus } }) => {
        const data = q.state.data
        if (data?.kind === 'delivered') {
          return Infinity
        }
        if (data?.kind === 'pending') {
          return 30_000
        }
        return 10_000
      },
      gcTime: 24 * 60 * 60 * 1_000,
      retry: 3,
      retryDelay: (attempt: number) => Math.min(9000, 1000 * 3 ** attempt),
      refetchOnWindowFocus: true,
    })),
  })

  // Subscribe to the journal index. The mutation pipeline writes to
  // `['pending-flow-ids']` via `setQueryData` whenever a new flow is
  // added or removed; mirroring it through `useQuery` lets this hook
  // re-render the moment a deposit/withdraw is submitted instead of
  // waiting on the 30s burn-page staleTime.
  const indexQuery = useQuery<string[]>({
    queryKey: ['pending-flow-ids'],
    queryFn: () => [],
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    initialData: [],
  })
  const journalIds = indexQuery.data ?? []

  // Per-flow subscription so phase transitions ('Submitting' →
  // 'Bridging' → terminal) re-render `rows` even before the burn tx
  // surfaces on RPC. Each entry's queryKey matches the one
  // `LiveJournalTracker` writes via `patchFlow`.
  const flowQueries = useQueries({
    queries: journalIds.map(id => ({
      queryKey: ['flow-status', id],
      queryFn: () => undefined as PersistedFlowStatus | undefined,
      enabled: false,
      staleTime: Infinity,
      gcTime: Infinity,
    })),
  })

  const rows: TimelineRow[] = useMemo(() => {
    const burnRows = allBurns.map((burn, i) => {
      const op = opQueries[i]?.data ?? null
      const journal = findJournalEntryBySignature(qc, burn.signature)
      return mergeRow(burn, op, journal, feeRaw)
    })
    // Synthesize optimistic rows for journal entries whose burn tx
    // hasn't been indexed by FOGO RPC yet. Filter to entries owned by
    // the current viewer and skip any that already have a canonical
    // row from the burn stream — the real row wins once it appears.
    const burnSigs = new Set(burnRows.map(r => r.signature))
    const synthetic: TimelineRow[] = []
    for (const fq of flowQueries) {
      const j = fq.data
      if (j === undefined || burnSigs.has(j.signature)) {
        continue
      }
      if (ownerB58 !== null && j.ownerB58 !== ownerB58) {
        continue
      }
      synthetic.push(rowFromJournal(j))
    }
    return [...synthetic, ...burnRows].sort((a, b) => b.blockTime - a.blockTime)
  }, [allBurns, opQueries, qc, feeRaw, flowQueries, ownerB58])

  return {
    rows,
    isLoading: burnQuery.isLoading,
    isError: burnQuery.isError,
    hasNextPage: burnQuery.hasNextPage ?? false,
    fetchNextPage: () => { burnQuery.fetchNextPage() },
    isFetchingNextPage: burnQuery.isFetchingNextPage,
  }
}
