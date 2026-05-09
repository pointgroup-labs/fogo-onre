import { QueryClient } from '@tanstack/react-query'

declare global {
  // eslint-disable-next-line vars-on-top
  var __fogoQueryClient: QueryClient | undefined
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: 2,
        refetchOnWindowFocus: false,
        throwOnError: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    // Server: a fresh client per request.
    return makeQueryClient()
  }
  // Browser: a single client memoized on globalThis to survive HMR.
  if (!globalThis.__fogoQueryClient) {
    globalThis.__fogoQueryClient = makeQueryClient()
  }
  return globalThis.__fogoQueryClient
}
