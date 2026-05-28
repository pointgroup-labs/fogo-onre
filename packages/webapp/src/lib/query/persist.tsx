'use client'

import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { QueryClientProvider } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { useState } from 'react'
import { getQueryClient } from './client'

const PERSIST_KEY = 'fogo-onre.queries.v1'

function shouldPersistKey(key: readonly unknown[]): boolean {
  // The flow record store uses `['flow-status', id]` (length 2) — that's
  // the only thing we want to survive reloads. `useFlowStatus` registers
  // a 5-tuple `['flow-status', sig, kind, owner, rpcUrl]` for live
  // polling that re-derives itself on every mount; persisting it would
  // just bloat localStorage and risk hydrating stale phase data.
  if (key[0] === 'pending-flow-ids') {
    return true
  }
  if (key[0] === 'flow-status' && key.length === 2 && typeof key[1] === 'string') {
    return true
  }
  // Orphan-deposit USDC recovery — value is immutable on-chain, so caching
  // the resolved bigint (decimal-stringified) collapses the visible jump.
  if (key[0] === 'deposit-usdc-amount') {
    return true
  }
  return false
}

/**
 * Rebuild `['pending-flow-ids']` from whatever `['flow-status', *]`
 * entries the cache holds after restoration.
 *
 * Why this exists: a previous version of the app seeded
 * `['pending-flow-ids']=[]` synchronously during render, which
 * out-stamped the persisted index and made `hydrate()` discard it on
 * every reload. The persister then re-saved the empty index,
 * permanently orphaning the per-tx `flow-status` blobs (which were
 * never overwritten). This walk recovers them.
 *
 * It's also a defensive invariant going forward: the index is
 * derivable from the flow entries, so any future divergence
 * (manual edit, stale snapshot, schema migration) self-heals at
 * boot.
 */
function reconcileFlowIndex(qc: QueryClient): void {
  const recovered: string[] = []
  for (const query of qc.getQueryCache().getAll()) {
    const key = query.queryKey
    if (key.length === 2 && key[0] === 'flow-status' && typeof key[1] === 'string') {
      const data = query.state.data as PersistedFlowStatus | null | undefined
      if (data && data.flowId === key[1]) {
        recovered.push(data.flowId)
      }
    }
  }
  // Sort by startedAt so the displayed order is stable and chronological.
  recovered.sort((a, b) => {
    const da = qc.getQueryData<PersistedFlowStatus>(['flow-status', a])
    const db = qc.getQueryData<PersistedFlowStatus>(['flow-status', b])
    return (da?.startedAt ?? 0) - (db?.startedAt ?? 0)
  })
  qc.setQueryData<string[]>(['pending-flow-ids'], recovered)
}

export default function QueryProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => getQueryClient())

  // Server render: plain QueryClientProvider (no localStorage available).
  if (typeof window === 'undefined') {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  const persister = createSyncStoragePersister({
    storage: window.localStorage,
    key: PERSIST_KEY,
  })

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        dehydrateOptions: {
          shouldDehydrateQuery: query =>
            query.state.status === 'success' && shouldPersistKey(query.queryKey),
        },
      }}
      onSuccess={() => reconcileFlowIndex(queryClient)}
    >
      {children}
    </PersistQueryClientProvider>
  )
}
