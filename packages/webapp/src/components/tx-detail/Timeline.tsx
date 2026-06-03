'use client'

import type { TxDetail } from './use-tx-data'
import { Check, Circle, Copy, ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import Image from 'next/image'
import { useState } from 'react'
import fogoIcon from '@/assets/tokens/fogo.svg'
import solanaIcon from '@/assets/tokens/solana.svg'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { markSignatureVisited, useVisitedSignatures } from '@/lib/evidence/visited'
import { cn } from '@/lib/utils'
import { fogoTxUrl, shortSig, solanaTxUrl, wormholeTxUrl } from '@/utils/explorers'
import { formatAbsoluteTime } from './format'

type StepState = 'done' | 'active' | 'idle'

interface Step {
  chain: 'FOGO' | 'Solana'
  title: string
  detail: string
  state: StepState
  /** Optional timestamp once the step is reached (ms). */
  atMs?: number
  /**
   * Copy shown beside the spinner while the step is `active`. Lets a step
   * whose on-chain work is multi-stage and unobservable from the browser
   * (e.g. the Solana relayer leg) explain *what* is pending instead of the
   * generic "waiting for confirmation" default.
   */
  activeHint?: string
  /** On-chain signature proving this step happened, if known. */
  receipt?: {
    signature: string
    explorer: 'FogoScan' | 'Solscan'
    href: string
  }
}

interface TimelineProps {
  detail: TxDetail
}

/**
 * Unified bridge progress + on-chain proof panel.
 *
 * **Why merged.** Two earlier cards (Bridge progress / On-chain proof)
 * said the same thing in two formats and forced the user to mentally
 * cross-reference "step 2 = which receipt?". The previous Evidence
 * panel's per-row Confirmed pill came from one signal
 * (`fogoDelivery.signature` exists) while Timeline's "done" state came
 * from another (`flow.phase`); they could disagree. Collapsing them to
 * one rule — **proof signature exists ⇔ step done** — kills the drift
 * and turns three steps × two views into three steps × one bundle.
 *
 * **Honest about uncertainty.** No `failed` state on bridge steps. The
 * only failure source we'd previously have was `flow.phase ===
 * 'expired'`, which is a UX heuristic ("baseline + N minutes elapsed
 * with no balance bump"), not on-chain proof of failure. False positives
 * for cold reloads (baseline captured post-delivery) and slow-but-
 * recoverable flows make a red X actively misleading. Three states
 * only: `done`, `active`, `idle`. A step is `active` when the prior
 * step is `done` and the current step's proof hasn't landed.
 *
 * **Verification grammar before completion.** When a step is `active`
 * or `idle`, the receipt-row area renders a placeholder rather than
 * disappearing — keeps the visual rhythm consistent so the user isn't
 * left wondering whether a missing receipt means "no proof yet" or
 * "we couldn't find proof". Visited tracking persists per-signature
 * across sessions so power users can re-orient themselves on returns
 * (rendered invisibly via aria-label; see `lib/evidence/visited.ts`).
 *
 * **Wormholescan tracker is not a step.** It's a third-party indexer
 * reference, surfaced as a single line below the steps with a quiet
 * disclosure explaining the false-Failed pill — same content as the
 * old Evidence tracker row, just folded under the same card header.
 *
 * **Spacing.** Inherits `Card`'s default `py-4 gap-4`. Don't override
 * with explicit padding — the rest of the detail page (`HeroSummary`,
 * `Actions`, `Help`) breathes at this rhythm.
 */
export function Timeline({ detail }: TimelineProps) {
  const visited = useVisitedSignatures()
  const steps = buildSteps(detail)
  const confirmedCount = steps.filter(s => s.state === 'done').length
  const allDelivered = steps.every(s => s.state === 'done')

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 px-5">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold tracking-tight">Bridge progress</h2>
          <ProgressVerdict count={confirmedCount} total={steps.length} allDelivered={allDelivered} />
        </div>
        <ol className="flex flex-col">
          {steps.map((step, i) => (
            <StepRow
              key={step.title}
              step={step}
              isLast={i === steps.length - 1}
              visited={step.receipt !== undefined && visited.has(step.receipt.signature)}
            />
          ))}
        </ol>
        <TrackerFooter
          sourceSignature={detail.signature}
          destinationSignature={detail.action?.destinationSig ?? detail.action?.finalSig ?? null}
          sourceIsSolana={detail.action?.anchorChain === 'Solana'}
          visited={visited}
        />
      </CardContent>
    </Card>
  )
}

/**
 * Section-header trust meta-signal: "how many of the bridge steps are
 * proven on-chain?" Sits next to the "Bridge progress" h2.
 *
 * **Why text-only, no pill.** A previous version rendered this as a
 * full pill (border + bg + font-medium + icon) which read at the same
 * visual weight as the per-step Confirmed pills below. Two competing
 * "look at me" elements at the top of the card — the eye couldn't
 * tell which was the headline and which was supporting. As a meta-
 * summary, this should be visually subordinate to the per-step proof
 * it summarises. Text + tabular-nums + a single ShieldCheck on
 * completion is enough.
 *
 * **Why a fraction, not a magnitude.** "3 on-chain receipts" is just
 * a count. "3 of 3 confirmed" is a count + progress bar in two words
 * — the user sees both "we're done" and "of how many" at once.
 * Mid-flight the magnitude form ("1 on-chain receipt") read as a
 * partial sentence; the fraction form ("1 of 3 confirmed") is a
 * complete progress signal even at one glance.
 *
 * **Why "confirmed" not "on-chain receipts".** Crypto-natives parse
 * either, but general DeFi users find "confirmed" more familiar.
 * Same information, less jargon. The "on-chain" qualifier is implied
 * by context (we're staring at a bridge timeline of on-chain steps).
 */
function ProgressVerdict({
  count,
  total,
  allDelivered,
}: {
  count: number
  total: number
  allDelivered: boolean
}) {
  const ariaLabel = allDelivered
    ? `All ${total} bridge steps confirmed on-chain`
    : `${count} of ${total} bridge steps confirmed on-chain`
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-[11px] tabular-nums transition-colors',
        allDelivered
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-muted-foreground',
      )}
      aria-label={ariaLabel}
    >
      {allDelivered && <ShieldCheck aria-hidden className="size-3" />}
      {count}
      {' of '}
      {total}
      {' confirmed'}
    </span>
  )
}

function StepRow({ step, isLast, visited }: { step: Step, isLast: boolean, visited: boolean }) {
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <StepIcon state={step.state} />
        {!isLast && (
          <div
            aria-hidden
            className={cn(
              'my-1 w-px flex-1',
              step.state === 'done' ? 'bg-emerald-500/30' : 'bg-border',
            )}
            style={{ minHeight: '2.5rem' }}
          />
        )}
      </div>
      <div className={cn('flex-1 pb-5', isLast && 'pb-0')}>
        <div className="flex items-center gap-2">
          <ChainIcon chain={step.chain} />
          <span
            className={cn(
              'text-sm font-medium',
              step.state === 'idle' ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {step.title}
          </span>
          {step.receipt !== undefined && (
            <span
              className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-600/20 bg-emerald-500/5 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700/90 dark:border-emerald-400/20 dark:text-emerald-300/90"
              title={visited ? 'You opened the explorer link for this transaction' : undefined}
              aria-label={visited ? 'Confirmed on-chain (you opened this in an explorer)' : 'Confirmed on-chain'}
            >
              <ShieldCheck aria-hidden className="size-3" />
              Confirmed
            </span>
          )}
        </div>
        <p
          className={cn(
            'mt-0.5 text-xs',
            step.state === 'idle' ? 'text-muted-foreground/70' : 'text-muted-foreground',
          )}
        >
          {step.detail}
        </p>
        {step.atMs !== undefined && step.state === 'done' && (
          <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground/80">
            {formatAbsoluteTime(step.atMs)}
          </p>
        )}
        <ReceiptArea step={step} />
      </div>
    </li>
  )
}

/**
 * Receipt area for a step. Three branches:
 *   - `done` + receipt → the proof row (sig, copy, explorer link)
 *   - `active`         → a quiet "waiting" placeholder so the row
 *                        keeps its vertical rhythm and the user
 *                        knows we're tracking, not silent
 *   - everything else (idle, or `done` with no receipt because the
 *     underlying tx isn't user-visible — e.g. paymaster-wrapped
 *     FOGO burns on orphan deposit-delivery rows) → render nothing
 */
function ReceiptArea({ step }: { step: Step }) {
  if (step.state === 'done' && step.receipt !== undefined) {
    return <ReceiptRow receipt={step.receipt} title={step.title} />
  }
  if (step.state === 'active') {
    return (
      <div className="mt-2 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 aria-hidden className="size-3 animate-spin" />
          {step.activeHint ?? 'Waiting for on-chain confirmation…'}
        </span>
      </div>
    )
  }
  return null
}

function ReceiptRow({
  receipt,
  title,
}: {
  receipt: NonNullable<Step['receipt']>
  title: string
}) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(receipt.signature)
      setCopied(true)
      setTimeout(setCopied, 1500, false)
    } catch {
      // Clipboard blocked (rare; iframe / insecure context). Silently
      // ignore — the user can still hit the explorer link.
    }
  }
  // Auxiliary clicks (middle-click, ⌘-click) open in a new tab and
  // skip onClick on some browsers — track on auxClick too so power
  // users who never use a left-click still get credit.
  const onExplorerClick = () => markSignatureVisited(receipt.signature)
  return (
    <div className="mt-2 flex items-center gap-2">
      <code
        className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs font-mono text-foreground/90"
        title={receipt.signature}
      >
        {shortSig(receipt.signature)}
      </code>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1 px-2 text-xs"
        onClick={onCopy}
        aria-label={copied ? 'Copied to clipboard' : `Copy signature for ${title}`}
      >
        {copied
          ? (
              <>
                <Check aria-hidden className="size-3.5 text-emerald-500" />
                <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
              </>
            )
          : (
              <>
                <Copy aria-hidden className="size-3.5" />
                <span className="sr-only sm:not-sr-only">Copy</span>
              </>
            )}
      </Button>
      <a
        href={receipt.href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={onExplorerClick}
        onAuxClick={onExplorerClick}
        className="inline-flex h-8 items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`Open ${title} in ${receipt.explorer}`}
      >
        {receipt.explorer}
        <ExternalLink aria-hidden className="size-3" />
      </a>
    </div>
  )
}

/**
 * Wormholescan is a third-party indexer that reports cross-chain
 * status but cannot itself prove delivery — its "Failed" pill can lag
 * or mislabel because OnRe redeems via a custom relayer CPI rather
 * than the standard NTT relayer Wormholescan tracks.
 *
 * Rendered as two quiet button-style links — same visual pattern as
 * ReceiptRow's per-step explorer links above (`hover:bg-muted` reveals
 * the affordance, `ExternalLink` icon signals "opens elsewhere"). No
 * default border, no default background — they sit at rest and only
 * "light up" on hover, so the row stays subordinate to the on-chain
 * receipts above. Two distinct targets, each self-contained and
 * recognizable as a clickable thing.
 *
 * The "Wormholescan may say Failed" caveat lives in a `title` tooltip
 * on the leading "Wormholescan" label — the natural anchor for "what
 * is this and what should I know about it?" Discoverable for users
 * who hover (cursor-help), invisible to scanners.
 */
function WormholescanLink({
  signature,
  visited,
  label,
}: {
  signature: string
  visited: Set<string>
  label: string
}) {
  // Distinct visited key namespace per side so the muted/visited state
  // tracks each link independently — clicking FOGO shouldn't dim
  // Solana, since they're separate verification acts.
  const visitedKey = `wh:${signature}`
  const onClick = () => markSignatureVisited(visitedKey)
  const isVisited = visited.has(visitedKey)
  return (
    <a
      href={wormholeTxUrl(signature)}
      target="_blank"
      rel="noreferrer noopener"
      onClick={onClick}
      onAuxClick={onClick}
      className={cn(
        'inline-flex h-8 items-center gap-1 rounded px-2 text-xs transition-colors',
        'text-muted-foreground hover:bg-muted hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        isVisited && 'text-foreground/80',
      )}
      aria-label={`Open ${label} side on Wormholescan`}
    >
      {label}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  )
}

function TrackerFooter({
  sourceSignature,
  destinationSignature,
  sourceIsSolana,
  visited,
}: {
  sourceSignature: string
  destinationSignature: string | null
  sourceIsSolana: boolean
  visited: Set<string>
}) {
  // Wormholescan's `/#/tx/<sig>` accepts either leg of an NTT operation
  // and resolves both to the same Operation page. We surface both
  // sides because the indexer occasionally fails to backfill the
  // destination edge — when that happens, the source link 404s the
  // delivery view but the destination link finds it directly.
  const sourceLabel = sourceIsSolana ? 'Solana' : 'FOGO'
  const destLabel = sourceIsSolana ? 'FOGO' : 'Solana'
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/60 pt-3 text-xs text-muted-foreground">
      <span
        className="cursor-help"
        title="Wormholescan only tracks the standard NTT relayer. OnRe redeems through a custom relayer CPI, so its status pill can lag or mislabel even after delivery completes — the receipts above are authoritative."
      >
        On Wormholescan
      </span>
      <div className="flex items-center gap-1">
        <WormholescanLink signature={sourceSignature} visited={visited} label={sourceLabel} />
        {destinationSignature !== null && (
          <WormholescanLink signature={destinationSignature} visited={visited} label={destLabel} />
        )}
      </div>
    </div>
  )
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <div className="flex size-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Check aria-hidden className="size-3.5" strokeWidth={2.5} />
      </div>
    )
  }
  if (state === 'active') {
    return (
      <div className="flex size-6 items-center justify-center rounded-full bg-foreground/10 text-foreground">
        <Loader2 aria-hidden className="size-3.5 animate-spin" />
      </div>
    )
  }
  return (
    <div className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground/50">
      <Circle aria-hidden className="size-3" />
    </div>
  )
}

function ChainIcon({ chain }: { chain: 'FOGO' | 'Solana' }) {
  // Both icons are real brand marks — self-contained circular logos.
  // No wrapper disc on either: each SVG IS its own disc (FOGO is red
  // with a white "F"; Solana is dark with the gradient three-stripe
  // glyph). Stacking them inside a tinted container would just be a
  // circle inside a circle. Next/Image gives us build-time hashing
  // and avoids CLS since dimensions are known statically.
  const src = chain === 'FOGO' ? fogoIcon : solanaIcon
  return (
    <Image
      src={src}
      alt={chain}
      title={chain}
      width={20}
      height={20}
      className="shrink-0 rounded-full"
    />
  )
}

function buildSteps(detail: TxDetail): Step[] {
  const { action, journal, fogoDelivery, flow, relayerStatus, signature } = detail
  const kind = action?.kind ?? journal?.kind ?? 'deposit'
  // Orphan deposit-delivery actions are anchored on the Solana source
  // tx (the user-side FOGO burn is paymaster-wrapped). For them,
  // `signature` is Solscan-shaped and `destinationSig` is the FOGO
  // delivery.
  const sourceIsSolana = action?.anchorChain === 'Solana'

  const journalStartMs = journal?.startedAt
  const rowBlockMs = action ? action.startedAt * 1000 : undefined
  // For orphan actions `action.startedAt` is the Solana arrival, not
  // the FOGO burn — use journal time for step 1 there and let step 2
  // carry the Solana time.
  const sourceTime = sourceIsSolana ? journalStartMs : (rowBlockMs ?? journalStartMs)
  const sourceSig = sourceIsSolana
    ? (action?.originSig ?? journal?.signature ?? null)
    : signature
  const sourceStep: Step | null = sourceSig === null && sourceIsSolana
    ? null
    : {
        chain: 'FOGO',
        title: kind === 'deposit' ? 'You sent USDC on FOGO' : 'You redeemed ONyc on FOGO',
        detail: kind === 'deposit'
          ? 'FOGO accepted your bridge request and locked your USDC for transfer.'
          : 'FOGO accepted your redemption and queued the bridge to send USDC back to you.',
        state: 'done',
        atMs: sourceTime,
        receipt: sourceSig !== null
          ? { signature: sourceSig, explorer: 'FogoScan', href: fogoTxUrl(sourceSig) }
          : undefined,
      }

  // Solana-side delivery. For normal actions this is `destinationSig`
  // (the relayer's Solana tx). For Solana-anchored actions,
  // `action.anchorSig` itself IS the Solana side (the NTT lock anchor).
  // Don't fall back to the URL `signature` here: deposit rows now link
  // via the FOGO burn or FOGO receipt, neither of which is the Solana
  // lock.
  // Final FOGO-side delivery sig, when we have one to link. Prefer the
  // action's `finalSig` (Wormholescan); fall back to the journal-free
  // FOGO delivery oracle (destination-ATA scan).
  const fogoFromRow = action?.finalSig ?? null
  const fogoOracleSig = fogoDelivery?.kind === 'delivered' ? fogoDelivery.signature : null
  const fogoReceiptSig = fogoFromRow ?? fogoOracleSig

  // Delivery truth, independent of Wormholescan. OnRe redeems via a custom
  // relayer CPI that Wormholescan's standard-NTT tracker doesn't index, so
  // `targetChain.txHash` (destinationSig/finalSig) lags or never fills. The
  // live `flow` watcher (destination-ATA balance bump — false positives
  // impossible) and the `fogoDelivery` ATA scan are authoritative on-chain
  // signals; trust any of them.
  const fogoDelivered = fogoReceiptSig !== null
    || flow?.phase === 'delivered'
    || action?.status === 'delivered'
    || action?.manuallyDismissed === true

  // Solana-side delivery sig (when Wormholescan surfaced it). Monotonic
  // completion: the destination token can't reach FOGO without the Solana
  // legs executing, so a proven final delivery implies this step is done
  // even when no Solana receipt was ever indexed.
  const solanaSig = sourceIsSolana ? (action?.anchorSig ?? null) : (action?.destinationSig ?? null)
  // `Swapped` means the relayer has converted the asset and is on the final
  // transfer_lock back to FOGO — the Solana leg is effectively done, so flip
  // this step to `done` and hand the spotlight to the FOGO delivery step even
  // before any Solana receipt is indexed.
  const relayerSwapped = relayerStatus === 'Swapped'
  const solanaDone = solanaSig !== null || fogoDelivered || relayerSwapped
  const solanaStep: Step = {
    chain: 'Solana',
    title: 'Bridge delivery on Solana',
    detail: kind === 'deposit'
      ? 'Where bridged USDC arrived on Solana — the relayer then swaps it to ONyc and bridges back.'
      : 'Where bridged ONyc arrived on Solana — the relayer then redeems it to USDC and bridges back.',
    state: solanaDone ? 'done' : 'active',
    atMs: sourceIsSolana ? rowBlockMs : undefined,
    // Active here means the relayer is still on Solana (received, converting).
    // Once it swaps (`relayerSwapped`) this step is `done` and the hint is
    // never shown — so the copy can safely describe the pre-swap stage.
    activeHint: kind === 'deposit'
      ? 'Converting USDC to ONyc on Solana…'
      : 'Redeeming ONyc to USDC on Solana…',
    receipt: solanaSig !== null
      ? { signature: solanaSig, explorer: 'Solscan', href: solanaTxUrl(solanaSig) }
      : undefined,
  }

  // Only trust the oracle's time when it describes the same tx as the
  // displayed sig — otherwise we render a mismatched (sig, time) pair.
  const fogoReceiptTime = fogoDelivery?.kind === 'delivered' && fogoDelivery.signature === fogoReceiptSig
    ? fogoDelivery.blockTime * 1000
    : undefined
  const fogoStep: Step = {
    chain: 'FOGO',
    title: kind === 'deposit'
      ? 'ONyc delivered to your FOGO wallet'
      : 'USDC delivered to your FOGO wallet',
    detail: kind === 'deposit'
      ? 'ONyc arrives in your wallet — your balance updates automatically.'
      : 'USDC arrives in your wallet — your balance updates automatically.',
    state: fogoDelivered
      ? 'done'
      : solanaDone ? 'active' : 'idle',
    // Shown once the Solana leg is done and we're awaiting the final mint.
    activeHint: kind === 'deposit'
      ? 'Bridging ONyc to FOGO…'
      : 'Bridging USDC to FOGO…',
    atMs: fogoReceiptTime,
    receipt: fogoReceiptSig !== null
      ? { signature: fogoReceiptSig, explorer: 'FogoScan', href: fogoTxUrl(fogoReceiptSig) }
      : undefined,
  }

  return [sourceStep, solanaStep, fogoStep].filter((s): s is Step => s !== null)
}
