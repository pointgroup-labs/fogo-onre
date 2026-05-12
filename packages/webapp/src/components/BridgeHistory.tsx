'use client'

import type { TimelineRow } from '@/lib/bridgeHistory/types'
import { isEstablished, useSession } from '@fogo/sessions-sdk-react'
import { useIsRestoring } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, Inbox, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS } from '@/constants'
import { useBridgeHistory } from '@/hooks/useBridgeHistory'
import { dismissBridge } from '@/lib/bridgeHistory/dismissed'

/**
 * How many rows to show before collapsing the rest behind a "Show more"
 * toggle. Five fits comfortably in a viewport and aligns with the recency
 * the user usually cares about; older rows (especially long-stuck
 * `Pending` ones whose oracle never resolved) are out of sight by default
 * but one click away. Tunable — bump to 7 if user feedback wants more
 * density visible at rest.
 */
const COLLAPSED_ROWS = 5

export default function BridgeHistory() {
  // Same hydration pattern as PendingTxList: defer the restoring branch
  // to a post-mount render so the first client paint matches the SSR
  // empty render.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const restoring = useIsRestoring()

  // 60s ticker drives relative-time labels in every row from a single
  // source of truth — keeps row renders pure and avoids N timers.
  const nowMs = useNowTicker(60_000)

  const session = useSession()
  const owner = isEstablished(session) ? session.walletPublicKey : null
  const { rows, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useBridgeHistory(owner)

  // Collapse state — keep the default view tight (5 rows). Older rows
  // are still in the DOM tree only when expanded; this keeps row-count
  // proportional to "what the user is actively triaging" instead of
  // "everything we've ever indexed".
  const [expanded, setExpanded] = useState(false)

  if (owner === null) {
    return null
  }

  if (mounted && restoring) {
    return <SkeletonList count={2} />
  }

  if (isLoading) {
    return <SkeletonList count={3} />
  }

  if (isError && rows.length === 0) {
    return (
      <Alert>
        <AlertTitle>Bridge history unavailable</AlertTitle>
        <AlertDescription>Couldn&apos;t load history. Try again in a moment.</AlertDescription>
      </Alert>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
        <Inbox aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No bridges yet</p>
        <p className="text-xs text-muted-foreground">Your deposits and withdrawals will appear here.</p>
      </div>
    )
  }

  const visibleRows = expanded ? rows : rows.slice(0, COLLAPSED_ROWS)
  const hiddenCount = rows.length - visibleRows.length
  const canCollapse = rows.length > COLLAPSED_ROWS

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <ul aria-label="Bridge history" className="flex flex-col gap-2">
          {visibleRows.map(r => <li key={r.signature}><BridgeRow row={r} nowMs={nowMs} /></li>)}
        </ul>
        {/*
          Soft fade overlay when collapsed AND there are hidden rows —
          a visual hint that more content lives below the fold without
          shouting. Pointer-events disabled so it doesn't intercept
          clicks on the bottom row.
        */}
        {!expanded && hiddenCount > 0 && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 rounded-b-xl bg-gradient-to-t from-background to-transparent"
          />
        )}
      </div>
      {canCollapse && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded(v => !v)}
          className="self-center text-xs text-muted-foreground"
        >
          {expanded
            ? (
                <>
                  Show less
                  <ChevronUp aria-hidden className="ml-1 size-3" />
                </>
              )
            : (
                <>
                  Show
                  {' '}
                  {hiddenCount}
                  {' '}
                  more
                  <ChevronDown aria-hidden className="ml-1 size-3" />
                </>
              )}
        </Button>
      )}
      {expanded && hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="self-center text-xs text-muted-foreground"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load older'}
        </Button>
      )}
    </div>
  )
}

function SkeletonList({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-[52px] rounded-xl" />
      ))}
    </div>
  )
}

function BridgeRow({ row, nowMs }: { row: TimelineRow, nowMs: number }) {
  const isDeposit = row.kind === 'deposit'
  const decimals = isDeposit ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const ticker = isDeposit ? 'USDC.s' : 'ONyc'
  const label = isDeposit ? 'Deposit' : 'Redeem'
  const amount = formatAmount(row.amountRaw, decimals)
  const blockMs = row.blockTime * 1000
  const relTime = formatRelativeTime(blockMs, nowMs)
  const { absTime, isoTime } = useMemo(() => {
    const d = new Date(blockMs)
    return { absTime: d.toLocaleString(), isoTime: d.toISOString() }
  }, [blockMs])
  const DirectionIcon = isDeposit ? ArrowUpRight : ArrowDownLeft

  // Programmatic navigation rather than wrapping the row in <Link>:
  // the existing FogoScan anchor inside the row would create invalid
  // nested-<a> markup. Inner interactives (source link, Mark delivered
  // button) stopPropagation so they don't double-trigger the navigation.
  const router = useRouter()
  const onRowClick = () => {
    router.push(`/tx/${row.signature}`)
  }
  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      router.push(`/tx/${row.signature}`)
    }
  }

  // Direction-coded icon tone — emerald for deposits (capital going in
  // to earn yield), violet for redeems (matches the Solana chain badge
  // in the detail-page Timeline so the visual language stays consistent
  // across surfaces). Very low bg + 60% stroke opacity keeps the hue
  // recognizable without pulling visual weight from the amount/status.
  const iconTone = isDeposit
    ? 'bg-emerald-500/5 text-emerald-700/60 dark:text-emerald-400/60'
    : 'bg-violet-500/5 text-violet-700/60 dark:text-violet-400/60'

  return (
    <Card
      className="group cursor-pointer py-0 ring-foreground/10 transition-shadow hover:ring-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:ring-white/70"
      role="link"
      tabIndex={0}
      aria-label={`View details for ${label} ${amount} ${ticker}`}
      onClick={onRowClick}
      onKeyDown={onRowKey}
    >
      <CardContent className="flex items-center gap-3 px-3.5 py-3">
        <span
          aria-hidden
          className={`flex size-8 shrink-0 items-center justify-center rounded-full ${iconTone}`}
        >
          <DirectionIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-medium tabular-nums">
            {row.amountIsApproximate
              ? (
                  <span
                    title="Approximate — reconstructed from on-chain data, may differ slightly from your typed amount"
                  >
                    ~
                    {amount}
                  </span>
                )
              : amount}
            {' '}
            <span className="font-normal text-muted-foreground">{ticker}</span>
          </span>
          <span className="mt-0.5 truncate text-xs text-muted-foreground">
            {label}
            {' · '}
            <time dateTime={isoTime} title={absTime}>{relTime}</time>
          </span>
        </div>
        <StatusBadge row={row} nowMs={nowMs} />
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground/50 dark:group-hover:text-white/70" />
      </CardContent>
    </Card>
  )
}

/**
 * Past this point, an unresolved row is almost certainly delivered —
 * the on-chain bridge SLA is minutes, not hours. The lazy
 * flow/op-status queries in `useBridgeHistory` only fire on first
 * mount of each row, so older entries that scrolled out before their
 * resolution round can stay stuck on "Pending" forever in the UI.
 * Treating anything older than this as "Likely delivered" turns that
 * dead state into a soft positive, while keeping the Mark-delivered
 * affordance available for the user to confirm.
 *
 * 2 hours is a generous bound: deposit happy path is ~3 min, redeem
 * happy path is ~10 min, and the Hero's slow-threshold (8/30 min)
 * already covers the "actually slow" range.
 */
const STUCK_PENDING_AGE_MS = 2 * 60 * 60_000

function StatusBadge({ row, nowMs }: { row: TimelineRow, nowMs: number }) {
  // Three render shapes — delivered (check), in-flight (spinner + phase),
  // pending (spinner + "Pending" + dismiss affordance).
  //
  // Precedence rationale:
  //   1. **Delivered first.** Wormholescan (`row.status`) and the
  //      per-device manual dismissal flag are the only *positive*
  //      delivery oracles we have. If either confirms delivery, we
  //      surface "Delivered" even when the local journal still says
  //      "In progress" — the journal is a soft local progress label
  //      driven by `LiveJournalTracker`'s FOGO-balance watch, which can
  //      lag, miss the balance bump (non-monotonic ATA writes), or
  //      simply never get patched to terminal if its observer race
  //      doesn't resolve. Checking the oracle first prevents the row
  //      from getting stuck on "In progress" forever after the tx
  //      detail page already confirmed delivery.
  //   2. **In-flight phase second.** Once we've ruled out a delivery
  //      oracle, the journal phase is the next best signal: it's the
  //      local "we're bridging" label and shows up before any oracle
  //      has had a chance to index the destination tx.
  //   3. **Pending fall-through.** No delivery, no journal → "Pending"
  //      with a Mark-delivered affordance so the user can resolve the
  //      legacy edge case where Wormholescan permanently can't see the
  //      destination tx (recovery-relayed `send_usdc_to_user` rows
  //      whose VAA was emitted by a separate tx so
  //      `/operations?txHash=<source>` has no `targetChain`).
  //
  // Manual dismissals render as the *same* Delivered badge as oracle-
  // confirmed deliveries; the distinction is preserved on
  // `row.manuallyDismissed` for debugging / analytics but is
  // intentionally invisible in the UI to avoid two near-identical
  // "Delivered" states confusing the user. Per-device, cosmetic,
  // reversible (clear `fogo-onre.dismissed-bridges.v1`).
  if (row.status === 'delivered' || row.manuallyDismissed) {
    return (
      <Badge
        variant="outline"
        aria-label="status: delivered"
        className="gap-1 border-emerald-600/20 bg-emerald-500/5 text-emerald-700/80 dark:border-emerald-400/20 dark:text-emerald-300/80"
      >
        <Check aria-hidden className="size-3" />
        Delivered
      </Badge>
    )
  }
  if (row.phase !== null) {
    return (
      <Badge variant="secondary" aria-label={`status: ${row.phase}`} className="gap-1">
        <Loader2 aria-hidden className="size-3 animate-spin" />
        {row.phase}
      </Badge>
    )
  }
  return (
    <div className="flex items-center gap-1.5">
      <PendingBadge row={row} nowMs={nowMs} />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={(e) => {
          // Don't bubble — the parent Card has a click handler that
          // navigates to the detail page; "Mark delivered" should stay
          // on the list.
          e.stopPropagation()
          dismissBridge(row.signature)
        }}
        title="Funds already in your wallet? Mark this row delivered. Per-device only; does not affect on-chain state."
        aria-label="Mark this bridge as delivered"
      >
        Mark delivered
      </Button>
    </div>
  )
}

/**
 * Renders the actual pending pill — split out so we can swap it for
 * a quieter "Likely delivered" variant on rows past the SLA window
 * without duplicating the surrounding Mark-delivered affordance.
 */
function PendingBadge({ row, nowMs }: { row: TimelineRow, nowMs: number }) {
  const ageMs = nowMs - row.blockTime * 1000
  if (ageMs > STUCK_PENDING_AGE_MS) {
    return (
      <Badge
        variant="outline"
        aria-label="status: likely delivered"
        title="Older than the typical bridge window with no failure signal — almost certainly delivered. Open the row to verify, or use Mark delivered to confirm."
        className="gap-1 border-muted-foreground/20 text-muted-foreground"
      >
        <Check aria-hidden className="size-3" />
        Likely delivered
      </Badge>
    )
  }
  return (
    <Badge variant="secondary" aria-label="status: pending" className="gap-1">
      <Loader2 aria-hidden className="size-3 animate-spin" />
      Pending
    </Badge>
  )
}

/**
 * Re-renders subscribers every `intervalMs`. Cheaper than per-row
 * timers; the component using this can pass `nowMs` to children so
 * their renders stay pure.
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

/**
 * Compact relative-time label. Falls back to "MMM D" past a week to
 * avoid "37 days ago" looking sloppy. Caller threads `nowMs` so this
 * stays pure.
 *
 * Threshold note: "just now" covers everything under a minute. The
 * earlier 45s/60s split produced a "0m ago" gap (45-59s ago →
 * `Math.floor(sec/60) === 0`); aligning the cutoff with the minute
 * boundary makes the label step `just now → 1m ago → 2m ago …`
 * monotonically.
 */
function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) {
    return 'just now'
  }
  const min = Math.floor(sec / 60)
  if (min < 60) {
    return `${min}m ago`
  }
  const hr = Math.floor(min / 60)
  if (hr < 24) {
    return `${hr}h ago`
  }
  const day = Math.floor(hr / 24)
  if (day < 7) {
    return `${day}d ago`
  }
  return new Date(thenMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatAmount(raw: bigint, decimals: number): string {
  // Display two decimal places of precision, dropping trailing zeros.
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const fraction = raw % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 2)
  // Strip trailing zeros from the 2-char fraction
  const trimmed = fractionStr.replace(/0+$/, '')
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole.toString()
}
