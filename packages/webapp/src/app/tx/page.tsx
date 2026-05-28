'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { Actions } from '@/components/tx-detail/Actions'
import { Help } from '@/components/tx-detail/Help'
import { HeroSummary } from '@/components/tx-detail/HeroSummary'
import { Timeline } from '@/components/tx-detail/Timeline'
import { useTxDetail } from '@/components/tx-detail/use-tx-data'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Per-tx detail page. Reached via `/tx?signature=<sig>`.
 *
 * **Why a query param instead of a dynamic segment?**
 * The webapp ships under `output: 'export'` (static export) for cheap
 * CDN-only hosting. Static export needs every URL known at build time
 * — dynamic-segment routes (`/tx/[signature]`) require enumerating
 * every possible signature in `generateStaticParams`, which is
 * fundamentally impossible for a sig-keyed route. A query-param route
 * is a single static page that reads the param at runtime, preserving
 * shareable per-tx URLs without breaking static export.
 *
 * **Loading state machine (resolved in this exact order):**
 *
 *   1. Session SDK is still booting (Initializing /
 *      CheckingStoredSession / WalletConnecting / …) → skeleton.
 *      Never the Connect-wallet prompt — distinguishing "still
 *      booting" from "definitively disconnected" is the whole point
 *      of `sessionInitializing`. Without this gate, every cold load
 *      flashed Connect-wallet for ~100–500 ms while the SDK booted.
 *
 *   2. Session is established AND history is loading AND we don't
 *      have a journal entry to render against → skeleton.
 *
 *   3. notFound (no row, no journal, history settled OR no session to
 *      load it with) → 404-style empty state with Wormholescan
 *      deep-link.
 *
 *   4. Otherwise → full detail layout.
 */
export default function TxDetailPage() {
  // `useSearchParams` requires a Suspense boundary at the page level
  // (it suspends during static-export prerender so the placeholder
  // shell can be emitted without `?signature=` resolved). Wrapping
  // here colocates the boundary with its consumer; the inner
  // component does the actual work.
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <TxDetailInner />
    </Suspense>
  )
}

function TxDetailInner() {
  const searchParams = useSearchParams()
  const signature = searchParams.get('signature') ?? ''
  const detail = useTxDetail(signature)
  const nowMs = useNowTicker(15_000)

  // Empty signature means the user hit `/tx` with no query param —
  // either a malformed share link or a stray click. Treat it as a
  // dedicated empty state rather than running data fetches against
  // an invalid signature.
  if (signature === '') {
    return (
      <Alert>
        <AlertTitle>No transaction selected</AlertTitle>
        <AlertDescription>
          This page expects a
          {' '}
          <code>?signature=</code>
          {' '}
          query parameter. Open a row from your transaction history to view its details.
        </AlertDescription>
      </Alert>
    )
  }

  // Gate 1+2: any "we don't yet know enough to render correctly" state
  // funnels into a single skeleton.
  const isSettling
    = detail.sessionInitializing
      || (detail.sessionEstablished && detail.historyLoading && detail.journal === null)

  if (isSettling) {
    return <DetailSkeleton />
  }

  // Gate 3: definitively absent — covers both "connected but signature
  // isn't yours" and "cold-share link with no local data". Both paths
  // get the Wormholescan deep-link, which is the only useful action in
  // either case.
  if (detail.notFound) {
    return (
      <Alert>
        <AlertTitle>Transaction not found</AlertTitle>
        <AlertDescription>
          This signature isn&apos;t in your transaction history. Double-check the link, or
          {' '}
          <a className="underline" href={`https://wormholescan.io/#/tx/${signature}`} target="_blank" rel="noopener noreferrer">
            look it up on Wormholescan
          </a>
          .
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <HeroSummary detail={detail} nowMs={nowMs} />
      <Timeline detail={detail} />
      <Actions detail={detail} />
      <Help />
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-[220px] rounded-xl" />
      <Skeleton className="h-[200px] rounded-xl" />
      <Skeleton className="h-[120px] rounded-xl" />
      <Skeleton className="h-[120px] rounded-xl" />
    </div>
  )
}

/**
 * 15s tick — fast enough that the "started X ago" label updates
 * smoothly, slow enough not to thrash React. The bridge-history list
 * uses a 60s ticker because rows are static; here the user is staring
 * at one row and expects it to feel alive.
 */
function useNowTicker(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now())
    }, intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [intervalMs])
  return now
}
