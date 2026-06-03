'use client'

import type { TxDetail } from './use-tx-data'
import { ArrowDownLeft, ArrowRight, ArrowUpRight, CheckCircle2, HelpCircle, Loader2 } from 'lucide-react'
import { TokenIcon } from '@/components/SymbolPill'
import { Card, CardContent } from '@/components/ui/card'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS, USDC_S_MINT } from '@/constants'
import { UNCONFIRMED_AFTER_MS } from '@/lib/bridgeHistory/displaySla'
import { parseAmountForDisplay } from '@/lib/bridgeHistory/merge'
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
 * neutral/Unconfirmed when we can't confirm from here. We NEVER render
 * red: there is no on-chain failure oracle, and a timeout (`expired`) is
 * "I don't know yet", not "it failed" — painting that red is the most
 * common bridge-UX mistake.
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
  const { action, flow, journal, fogoDelivery } = detail

  const kind = action?.kind ?? journal?.kind ?? 'deposit'
  const isDeposit = kind === 'deposit'

  // `delivered` aggregates every signal that proves the bridge completed.
  // Including `fogoDelivery` is what kills the residual "Taking longer
  // than usual" flash: on a reload where `flow` briefly re-resolves
  // through `submitted → bridging → delivered`, the deterministic
  // FOGO-side delivery oracle has *already* found the mint signature —
  // trust it as authoritative.
  const delivered
    = action?.status === 'delivered'
      || action?.manuallyDismissed === true
      || flow?.phase === 'delivered'
      || fogoDelivery?.kind === 'delivered'
  // `expired` is a *timeout* heuristic (SLA elapsed with no balance bump
  // yet), never on-chain proof of failure — we have no failure oracle. So we
  // never paint red; a timed-out flow is surfaced honestly as "Unconfirmed".
  const timedOut = flow?.phase === 'expired'
  const inFlight = !delivered

  const sourceSymbol = isDeposit ? 'USDC' : 'ONyc'
  const destSymbol = isDeposit ? 'ONyc' : 'USDC'
  const mintIsUsdc = action?.displayMintB58 === USDC_S_MINT.toBase58()
  // Deposits always show the USDC the user sent, never the ONyc
  // received: the amount is sourced only from USDC-denominated data
  // (the detail-page recovery overlay or the device journal) and falls
  // to a placeholder otherwise. Withdraws keep their mint-driven branch.
  const amountSymbol = isDeposit
    ? 'USDC'
    : (action?.displayMintB58 !== undefined ? (mintIsUsdc ? 'USDC' : 'ONyc') : sourceSymbol)
  const sourceDecimals = amountSymbol === 'USDC' ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const actionAmountUsable = isDeposit ? mintIsUsdc : action?.displayMintB58 !== undefined
  const amountRaw = (actionAmountUsable ? action?.displayAmountRaw : undefined)
    ?? (journal ? parseAmountForDisplay(journal.amountStr, sourceDecimals) : null)
  const amountStr = amountRaw != null
    ? formatAmount(amountRaw, sourceDecimals)
    : '—'
  // For orphan delivery actions the amount is in the destination token,
  // so the source→dest arrow would re-state the same symbol. Drop it.
  const showArrow = amountSymbol === sourceSymbol

  const startedAt = journal?.startedAt ?? (action ? action.startedAt * 1000 : null)
  const elapsedLabel = startedAt !== null
    ? formatRelativeTime(startedAt, nowMs)
    : null

  // `isSlow` drives the amber headline tone and the EtaHint copy.
  // Threshold matches EtaHint's expectation: deposits ~8 min, redeems ~30 min.
  //
  // Critically, we require *positive in-flight evidence* (a `flow.phase`
  // or an `action.phase`) before painting amber. Without this guard, a
  // hero rendered from a stale journal alone (e.g. opened from a cold
  // link 40 min after `startedAt`) flashes amber for one render before
  // the live `flow` watcher resolves to `delivered` — the original
  // "yellow-flash" half of the loading cascade.
  const elapsedMs = startedAt !== null ? Math.max(0, nowMs - startedAt) : 0
  const slowThresholdMs = (isDeposit ? 8 : 30) * 60_000
  const hasLiveStatus = flow?.phase != null || action?.phase != null

  // Honest "we couldn't confirm delivery from here." Either the watcher
  // timed out (`timedOut`) or there was never a live signal and we're past
  // the SLA window. Takes precedence over `isSlow` so a timed-out flow reads
  // as Unconfirmed (neutral) rather than a perpetual amber "taking longer".
  const unconfirmed = inFlight
    && (timedOut || (!hasLiveStatus && elapsedMs > UNCONFIRMED_AFTER_MS))

  // Amber "slow but progressing": positive in-flight evidence, past the SLA,
  // but not yet timed-out/unconfirmed. The `hasLiveStatus` guard stops a
  // stale-journal cold load from flashing amber before the live watcher
  // resolves (the original "yellow-flash" bug).
  const isSlow = inFlight && !unconfirmed && hasLiveStatus && elapsedMs > slowThresholdMs

  const headline = delivered
    ? 'Delivered'
    : unconfirmed
      ? 'Unconfirmed'
      : isSlow
        ? 'Taking longer than usual'
        : statusVerb(flow?.phase ?? action?.phase ?? null)

  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-7 text-center">
        <DirectionGlyph isDeposit={isDeposit} delivered={delivered} unconfirmed={unconfirmed} />
        <div className="flex flex-col gap-1">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {isDeposit ? 'Deposit' : 'Redeem'}
          </div>
          <h1 className={`text-2xl font-semibold tracking-tight ${headlineTone(delivered, isSlow)}`}>
            {headline}
          </h1>
          <div className="mt-1 inline-flex items-center justify-center gap-2 text-sm tabular-nums">
            <span className="font-medium">{amountStr}</span>
            <span className="inline-flex items-center gap-1">
              <TokenIcon symbol={amountSymbol} size={16} />
              <span className="text-muted-foreground">{amountSymbol}</span>
            </span>
            {showArrow && (
              <>
                <ArrowRight aria-hidden className="size-3.5 text-muted-foreground/60" />
                <span className="inline-flex items-center gap-1">
                  <TokenIcon symbol={destSymbol} size={16} />
                  <span className="text-muted-foreground">{destSymbol}</span>
                </span>
              </>
            )}
          </div>
        </div>
        {elapsedLabel !== null && (
          <div className="text-xs text-muted-foreground">
            {delivered
              ? `Completed · started ${elapsedLabel}`
              : `Started ${elapsedLabel}`}
          </div>
        )}
        {inFlight && !unconfirmed && <EtaHint isSlow={isSlow} kind={kind} />}
        {unconfirmed && (
          <p className="max-w-sm text-xs text-muted-foreground">
            Older than the typical bridge window and we couldn't confirm delivery from here. Check the timeline below, or your FOGO wallet balance.
          </p>
        )}
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
    case 'expired': return 'Taking longer than usual'
    case null: return 'Just started'
    default: return phase.charAt(0).toUpperCase() + phase.slice(1)
  }
}

function headlineTone(delivered: boolean, isSlow: boolean): string {
  if (delivered) {
    return 'text-emerald-600 dark:text-emerald-400'
  }
  if (isSlow) {
    return 'text-amber-600 dark:text-amber-400'
  }
  return 'text-foreground'
}

function DirectionGlyph({
  isDeposit,
  delivered,
  unconfirmed,
}: {
  isDeposit: boolean
  delivered: boolean
  unconfirmed: boolean
}) {
  let Icon = isDeposit ? ArrowUpRight : ArrowDownLeft
  let tone = 'bg-muted text-foreground/70'
  if (delivered) {
    Icon = CheckCircle2
    tone = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  } else if (unconfirmed) {
    Icon = HelpCircle
    tone = 'bg-muted text-muted-foreground'
  }
  return (
    <div aria-hidden className={`flex size-12 items-center justify-center rounded-full ${tone}`}>
      {delivered || unconfirmed
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
