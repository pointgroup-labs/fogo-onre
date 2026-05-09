'use client'

import type { ReactNode } from 'react'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { QueryClientProvider } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { useState } from 'react'
import { getQueryClient } from './client'

const PERSIST_KEY = 'fogo-onre.queries.v1'

function shouldPersistKey(key: readonly unknown[]): boolean {
  const head = key[0]
  return head === 'flow-status' || head === 'pending-flow-ids'
}

export default function QueryProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => {
    const qc = getQueryClient()
    if (qc.getQueryData(['pending-flow-ids']) === undefined) {
      qc.setQueryData<string[]>(['pending-flow-ids'], [])
    }
    return qc
  })

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
          shouldDehydrateQuery: query => shouldPersistKey(query.queryKey),
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}
