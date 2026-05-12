'use client'

import type { TxDetail } from './use-tx-data'
import { ArrowDownLeft, ArrowRight, ArrowUpRight, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { TokenIcon } from '@/components/SymbolPill'
import { Card, CardContent } from '@/components/ui/card'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS } from '@/constants'
import { formatAmount, formatRelativeTime } from './format'

interface HeroSummaryProps {
  detail: TxDetail
  nowMs: number
}

/**
 * Top-of-page narrative summary. Single-purpose: answer "did my money
 * make it, and roughly when?" inside the first viewport.
 *
 * UX inversion vs. the original layout: the status *verb* is the
 * headline (Primacy Effect — first thing users read tells them whether
 * their money is OK), and the amount is the supporting context below.
 *
 * Color semantics — green only on `delivered`, amber for slow-but-OK,
 * red ONLY when we have a positive `expired` signal. Never use red to
 * mean "I don't know yet"; that's the most common bridge-UX mistake.
 *
 * **No destination amount estimate.** We deliberately render only the
 * source amount + destination *symbol* (no number). Estimating the
 * delivered amount needs the protocol fee bps and the live price, both
 * of which sit behind a Suspense boundary in `useProtocolState`. More
 * importantly, the *real* post-fee delivered value is one scroll away
 * in the Timeline's mint receipt — competing with that with an
 * approximation just raises "which number is real?" doubt. Honest
 * minimalism beats a clever-but-wrong number.
 */
export function HeroSummary({ detail, nowMs }: HeroSummaryProps) {
  const { row, flow, journal, fogoDelivery } = detail

  const kind = row?.kind ?? journal?.kind ?? 'deposit'
  const isDeposit = kind === 'deposit'

  // `delivered` aggregates every signal that proves the bridge completed.
  // Including `fogoDelivery` is what kills the residual "Taking longer
  // than usual" flash: on a reload where `flow` briefly re-resolves
  // through `submitted → bridging → delivered`, the deterministic
  // FOGO-side delivery oracle has *already* found the mint signature —
  // trust it as authoritative.
  const delivered
    = row?.status === 'delivered'
      || row?.manuallyDismissed === true
      || flow?.phase === 'delivered'
      || fogoDelivery?.kind === 'delivered'
  const failed = flow?.phase === 'expired'
  const inFlight = !delivered && !failed

  const amountRaw = row?.amountRaw ?? (journal ? BigInt(journal.amountStr) : null)
  const sourceSymbol = isDeposit ? 'USDC.s' : 'ONyc'
  const destSymbol = isDeposit ? 'ONyc' : 'USDC.s'
  const sourceDecimals = isDeposit ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const amountStr = amountRaw !== null
    ? formatAmount(amountRaw, sourceDecimals)
    : '—'

  const startedAt = journal?.startedAt ?? (row ? row.blockTime * 1000 : null)
  const elapsedLabel = startedAt !== null
    ? formatRelativeTime(startedAt, nowMs)
    : null

  // `isSlow` drives the amber headline tone and the EtaHint copy.
  // Threshold matches EtaHint's expectation: deposits ~8 min, redeems ~30 min.
  //
  // Critically, we require *positive in-flight evidence* (a `flow.phase`
  // or a `row.phase`) before painting amber. Without this guard, a hero
  // rendered from a stale journal alone (e.g. opened from a cold link
  // 40 min after `startedAt`) flashes amber for one render before the
  // live `flow` watcher resolves to `delivered` — the original
  // "yellow-flash" half of the loading cascade.
  const elapsedMs = startedAt !== null ? Math.max(0, nowMs - startedAt) : 0
  const slowThresholdMs = (isDeposit ? 8 : 30) * 60_000
  const hasLiveStatus = flow?.phase != null || row?.phase != null
  const isSlow = inFlight && hasLiveStatus && elapsedMs > slowThresholdMs

  const headline = delivered
    ? 'Delivered'
    : failed
      ? 'Stalled'
      : isSlow
        ? 'Taking longer than usual'
        : statusVerb(flow?.phase ?? row?.phase ?? null)

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-7 text-center">
        <DirectionGlyph isDeposit={isDeposit} delivered={delivered} failed={failed} />
        <div className="flex flex-col gap-1">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {isDeposit ? 'Deposit' : 'Redeem'}
          </div>
          <h1 className={`text-2xl font-semibold tracking-tight ${headlineTone(delivered, failed, isSlow)}`}>
            {headline}
          </h1>
          <div className="mt-1 inline-flex items-center justify-center gap-2 text-sm tabular-nums">
            <span className="font-medium">{amountStr}</span>
            <span className="inline-flex items-center gap-1">
              <TokenIcon symbol={sourceSymbol} size={16} />
              <span className="text-muted-foreground">{sourceSymbol}</span>
            </span>
            <ArrowRight aria-hidden className="size-3.5 text-muted-foreground/60" />
            <span className="inline-flex items-center gap-1">
              <TokenIcon symbol={destSymbol} size={16} />
              <span className="text-muted-foreground">{destSymbol}</span>
            </span>
          </div>
        </div>
        {elapsedLabel !== null && (
          <div className="text-xs text-muted-foreground">
            {delivered
              ? `Completed · started ${elapsedLabel}`
              : failed
                ? `Stalled · started ${elapsedLabel}`
                : `Started ${elapsedLabel}`}
          </div>
        )}
        {inFlight && <EtaHint isSlow={isSlow} kind={kind} />}
        {delivered && (
          <p className="text-xs text-muted-foreground">
            <span className="text-foreground/80">{destSymbol}</span>
            {' '}
            has arrived in your FOGO wallet.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function statusVerb(phase: string | null): string {
  // Verb-led copy beats noun-led — "Bridging" reads as in-progress,
  // "Bridge" reads as a thing. Each verb is the user-facing translation
  // of an internal phase. "Submitting" alone is vague (submitting *what*
  // *where*?), so we say "Confirming on FOGO" to anchor the action.
  switch (phase) {
    case 'submitted': return 'Confirming on FOGO'
    case 'bridging': return 'Bridging'
    case 'delivered': return 'Delivered'
    case 'expired': return 'Stalled'
    case null: return 'Just started'
    default: return phase.charAt(0).toUpperCase() + phase.slice(1)
  }
}

function headlineTone(delivered: boolean, failed: boolean, isSlow: boolean): string {
  if (delivered) {
    return 'text-emerald-600 dark:text-emerald-400'
  }
  if (failed) {
    return 'text-red-600 dark:text-red-400'
  }
  if (isSlow) {
    return 'text-amber-600 dark:text-amber-400'
  }
  return 'text-foreground'
}

function DirectionGlyph({
  isDeposit,
  delivered,
  failed,
}: {
  isDeposit: boolean
  delivered: boolean
  failed: boolean
}) {
  let Icon = isDeposit ? ArrowUpRight : ArrowDownLeft
  let tone = 'bg-muted text-foreground/70'
  if (delivered) {
    Icon = CheckCircle2
    tone = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  } else if (failed) {
    Icon = XCircle
    tone = 'bg-red-500/10 text-red-600 dark:text-red-400'
  }
  return (
    <div aria-hidden className={`flex size-12 items-center justify-center rounded-full ${tone}`}>
      {delivered || failed
        ? <Icon className="size-6" strokeWidth={2} />
        : <Loader2 className="size-6 animate-spin" />}
    </div>
  )
}

function EtaHint({ isSlow, kind }: { isSlow: boolean, kind: 'deposit' | 'withdraw' }) {
  const expectedRange = kind === 'deposit' ? '2–4 min' : '5–10 min'
  if (isSlow) {
    return (
      <p className="max-w-sm text-xs text-amber-600/90 dark:text-amber-400/90">
        The bridge is still working. Your funds are safe on-chain — check the timeline below to see the current step.
      </p>
    )
  }
  return (
    <p className="text-xs text-muted-foreground">
      Usually completes in
      {' '}
      <span className="text-foreground/80">{expectedRange}</span>
    </p>
  )
}
