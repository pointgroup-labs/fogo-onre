'use client'

import type { DisplayAction } from '@/lib/bridgeHistory/bridgeAction'
import { isEstablished, useSession } from '@fogo/sessions-sdk-react'
import { useIsRestoring } from '@tanstack/react-query'
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, HelpCircle, Inbox, Loader2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS, USDC_S_MINT } from '@/constants'
import { useBridgeHistory } from '@/hooks/useBridgeHistory'
import { useDepositUsdcAmount } from '@/hooks/useDepositUsdcAmount'
import { dismissBridge } from '@/lib/bridgeHistory/dismissed'
import { UNCONFIRMED_AFTER_MS } from '@/lib/bridgeHistory/displaySla'

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
  const { actions, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useBridgeHistory(owner)

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

  if (isError && actions.length === 0) {
    return (
      <Alert>
        <AlertTitle>History unavailable</AlertTitle>
        <AlertDescription>Couldn&apos;t load history. Try again in a moment.</AlertDescription>
      </Alert>
    )
  }

  if (actions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
        <Inbox aria-hidden className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No transactions yet</p>
        <p className="text-xs text-muted-foreground">Your deposits and withdrawals will appear here.</p>
      </div>
    )
  }

  const visibleActions = expanded ? actions : actions.slice(0, COLLAPSED_ROWS)
  const hiddenCount = actions.length - visibleActions.length
  const canCollapse = actions.length > COLLAPSED_ROWS

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <ul aria-label="Transaction history" className="flex flex-col gap-2">
          {visibleActions.map(a => <li key={a.anchorSig}><BridgeRow action={a} nowMs={nowMs} /></li>)}
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

function BridgeRow({ action, nowMs }: { action: DisplayAction, nowMs: number }) {
  const isDeposit = action.kind === 'deposit'
  const mintIsUsdc = action.displayMintB58 === USDC_S_MINT.toBase58()
  // Deposits read as the USDC the user sent, never the ONyc received.
  // Same-device deposits already carry USDC (journal overlay); orphan
  // deposits (cross-device / journal-less) arrive ONyc-denominated, so
  // recover the USDC on demand for this visible row — cached + persisted,
  // ~3 RPC once per deposit rather than eagerly across all history.
  const needsUsdcRecovery = isDeposit && !mintIsUsdc && action.anchorChain === 'Solana'
  const recoveredUsdc = useDepositUsdcAmount(needsUsdcRecovery ? action.anchorSig : null)
  const depositAmountPending = isDeposit && !mintIsUsdc && recoveredUsdc === null
  const depositUsdcRaw = isDeposit && !mintIsUsdc ? recoveredUsdc : null
  const ticker = isDeposit ? 'USDC' : (mintIsUsdc ? 'USDC' : 'ONyc')
  const decimals = mintIsUsdc ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const amountText = depositAmountPending
    ? '—'
    : depositUsdcRaw !== null
      ? formatAmount(depositUsdcRaw, USDC_DECIMALS)
      : formatAmount(action.displayAmountRaw, decimals)
  const label = isDeposit ? 'Deposit' : 'Redeem'
  const blockMs = action.startedAt * 1000
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
  // Route is `/tx?signature=<sig>` (query param, not dynamic segment)
  // because the webapp ships under `output: 'export'` — see the JSDoc
  // on `/tx/page.tsx` for the rationale.
  const router = useRouter()
  // Prefer the FOGO-side sig the user can recognize. For paymaster-
  // wrapped deposits `action.anchorSig` is the Solana NTT lock (the
  // only anchor Wormholescan returns); `originSig` is the user's FOGO
  // burn when journal-matched, `finalSig` is the FOGO receipt — both
  // are strictly more meaningful than the relayer's Solana lock.
  const preferredSig = isDeposit
    ? (action.originSig ?? action.finalSig ?? action.anchorSig)
    : action.anchorSig
  const txHref = `/tx?signature=${preferredSig}`
  const onRowClick = () => {
    router.push(txHref)
  }
  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      router.push(txHref)
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
      aria-label={`View details for ${label} ${amountText} ${ticker}`}
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
            <span title={depositAmountPending ? 'Recovering the deposit amount from chain history…' : undefined}>
              {amountText}
            </span>
            {' '}
            <span className="font-normal text-muted-foreground">{ticker}</span>
          </span>
          <span className="mt-0.5 truncate text-xs text-muted-foreground">
            {label}
            {' · '}
            <time dateTime={isoTime} title={absTime}>{relTime}</time>
          </span>
        </div>
        <StatusBadge action={action} nowMs={nowMs} />
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground/50 dark:group-hover:text-white/70" />
      </CardContent>
    </Card>
  )
}

function StatusBadge({ action, nowMs }: { action: DisplayAction, nowMs: number }) {
  // Three render shapes — delivered (check), in-flight (spinner + phase),
  // pending (spinner + "Pending" + dismiss affordance).
  //
  // Precedence rationale:
  //   1. **Delivered first.** Four positive delivery oracles, any of
  //      which wins: Wormholescan (`action.status`), the per-device
  //      manual dismissal flag, the device-local journal reaching
  //      `terminal-success` (`action.journalDelivered`), and the
  //      destination-ATA balance scan (`action.chainDelivered`, overlaid
  //      in `useBridgeHistory`). Wormholescan NEVER flips to delivered
  //      for OnRe's custom relayer-CPI redeem, so the latter two are what
  //      stop a row getting stuck on "Pending"/"Unconfirmed": the journal
  //      covers same-device rows, the ATA scan covers cross-device /
  //      cold-link rows with no journal.
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
  // `action.manuallyDismissed` for debugging / analytics but is
  // intentionally invisible in the UI to avoid two near-identical
  // "Delivered" states confusing the user. Per-device, cosmetic,
  // reversible (clear `fogo-onre.dismissed-bridges.v1`).
  if (action.status === 'delivered' || action.manuallyDismissed || action.journalDelivered || action.chainDelivered) {
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
  if (action.phase !== null) {
    return (
      <Badge variant="secondary" aria-label={`status: ${action.phase}`} className="gap-1">
        <Loader2 aria-hidden className="size-3 animate-spin" />
        {action.phase}
      </Badge>
    )
  }
  return (
    <div className="flex items-center gap-1.5">
      <PendingBadge action={action} nowMs={nowMs} />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={(e) => {
          // Don't bubble — the parent Card has a click handler that
          // navigates to the detail page; "Mark delivered" should stay
          // on the list.
          e.stopPropagation()
          dismissBridge(action.anchorSig)
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
 * a neutral "Unconfirmed" variant on rows past the SLA window without
 * duplicating the surrounding Mark-delivered affordance.
 */
function PendingBadge({ action, nowMs }: { action: DisplayAction, nowMs: number }) {
  const ageMs = nowMs - action.startedAt * 1000
  if (ageMs > UNCONFIRMED_AFTER_MS) {
    return (
      <Badge
        variant="outline"
        aria-label="status: unconfirmed"
        title="Older than the typical bridge window and we couldn't confirm the delivery on the indexer. If the funds arrived in your wallet, use Mark delivered to confirm."
        className="gap-1 border-muted-foreground/20 text-muted-foreground"
      >
        <HelpCircle aria-hidden className="size-3" />
        Unconfirmed
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
