'use client'

import type { PublicKey } from '@solana/web3.js'
import type { BurnRow, OperationStatus, TimelineRow } from '@/lib/bridgeHistory/types'
import { useInfiniteQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { findJournalEntryBySignature, mergeRow } from '@/lib/bridgeHistory/merge'
import { fetchBurnPage, getCanonicalAtas } from '@/lib/bridgeHistory/rpc'
import { fetchOperationStatus } from '@/lib/bridgeHistory/wormholescan'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

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

  const rows: TimelineRow[] = useMemo(() => {
    return allBurns.map((burn, i) => {
      const op = opQueries[i]?.data ?? null
      const journal = findJournalEntryBySignature(qc, burn.signature)
      return mergeRow(burn, op, journal)
    })
  }, [allBurns, opQueries, qc])

  return {
    rows,
    isLoading: burnQuery.isLoading,
    isError: burnQuery.isError,
    hasNextPage: burnQuery.hasNextPage ?? false,
    fetchNextPage: () => { burnQuery.fetchNextPage() },
    isFetchingNextPage: burnQuery.isFetchingNextPage,
  }
}
