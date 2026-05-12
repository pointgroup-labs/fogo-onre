'use client'

import { use, useEffect, useState } from 'react'
import { Actions } from '@/components/tx-detail/Actions'
import { Help } from '@/components/tx-detail/Help'
import { HeroSummary } from '@/components/tx-detail/HeroSummary'
import { Timeline } from '@/components/tx-detail/Timeline'
import { useTxDetail } from '@/components/tx-detail/use-tx-data'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Per-tx detail page. The URL carries the source FOGO signature; we
 * try to resolve a rich detail object via `useTxDetail` and degrade
 * gracefully when we can't.
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
 *      have a journal entry to render against → skeleton. We *could*
 *      render the Hero on a journal alone, but mid-flight journals
 *      with a stale `startedAt` cause the slow-amber flash before
 *      `flow` resolves; gating on `journal !== null || !historyLoading`
 *      keeps us in the skeleton until at least one trustworthy data
 *      source has landed.
 *
 *   3. notFound (no row, no journal, history settled OR no session to
 *      load it with) → 404-style empty state with Wormholescan
 *      deep-link. Replaces the old "connect wallet" prompt: on a
 *      cold-share link, connecting a wallet wouldn't surface someone
 *      else's tx — the only useful action is to follow the bridge on
 *      Wormholescan, which is exactly what this view offers.
 *
 *   4. Otherwise → full detail layout.
 *
 * The `nowMs` ticker drives relative-time labels in the hero. We
 * thread it through props (not context) so the children stay pure
 * and easy to test in isolation.
 */
export default function TxDetailPage({ params }: { params: Promise<{ signature: string }> }) {
  // Next 15: route params are a Promise; `use()` unwraps it sync. This
  // is the documented pattern for client-component pages.
  const { signature } = use(params)
  const detail = useTxDetail(signature)
  const nowMs = useNowTicker(15_000)

  // Gate 1+2: any "we don't yet know enough to render correctly" state
  // funnels into a single skeleton. One render path = one transition,
  // which kills the connect-wallet → yellow-flash → data → skeleton
  // cascade caused by branching on each independent loading flag.
  const isSettling
    = detail.sessionInitializing
      || (detail.sessionEstablished && detail.historyLoading && detail.journal === null)

  if (isSettling) {
    return <DetailSkeleton />
  }

  // Gate 3: definitively absent — covers both "connected but signature
  // isn't yours" and "cold-share link with no local data". Both paths
  // get the Wormholescan deep-link, which is the only useful action in
  // either case (a wallet connect wouldn't surface someone else's tx).
  if (detail.notFound) {
    return (
      <Alert>
        <AlertTitle>Transaction not found</AlertTitle>
        <AlertDescription>
          This signature isn&apos;t in your bridge history. Double-check the link, or
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
  // Mirror the rough shape of the loaded page so the layout doesn't
  // jump on hydration: tall hero, medium timeline, two short cards.
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
