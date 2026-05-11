/**
 * OnRe-cancel fingerprint handler — extracted from `claim-redemption-usdc.ts`
 * so the cancel-branch logic (rate-limit, quote, log shaping, metric
 * increments) is testable in isolation.
 *
 * Why a dedicated module:
 *  - The caller needs ~7 RPCs and a real NTT VAA to even *reach* the
 *    cancel branch, which makes integration testing the cancel branch
 *    via `claimRedemptionUsdc(...)` cost-prohibitive. Extracting the
 *    branch lets us inject a mock quoter and assert exactly the
 *    behaviors that matter for deploy-readiness.
 *  - The rate-limit cache lives at module scope (per-process state).
 *    Putting both the cache and the entry point in this module keeps
 *    that state encapsulated and gives tests a `__resetForTests` hook.
 *
 * Behaviors pinned by tests (`cancel-redemption-handler.test.ts`):
 *  - First sighting per flow → warn + Jupiter quote + counters.
 *  - Subsequent ticks within `QUOTE_PREVIEW_TTL_MS` → info + no quote.
 *  - Cache evicts entries older than `2 × QUOTE_PREVIEW_TTL_MS` AND is
 *    hard-capped so a long-running daemon cannot leak memory.
 */
import type { PublicKey } from '@solana/web3.js'
import type { Metrics } from '../metrics'
import type { Logger } from '../utils/log'
import type { QuoteRedeemOnycRecoveryResult } from './redeem-onyc-quote'

/**
 * Quote-cooldown window. Cancel fingerprint persists for the full
 * ~2-day on-chain `redeem_onyc` cooldown; without rate-limiting, a 30s
 * scan loop would emit ~5_760 Jupiter calls per stuck flow.
 */
export const QUOTE_PREVIEW_TTL_MS = 5 * 60 * 1000

/**
 * Hard cap on the cache. With each entry ~80 bytes (base58 key +
 * number value + Map overhead), 1000 entries ≈ 80 KB — negligible —
 * but more than the daemon can plausibly see in a year of stuck flows.
 * If we ever exceed this, something is fundamentally wrong upstream and
 * we should know via the eviction-overflow metric, not a silent leak.
 */
const MAX_CACHE_ENTRIES = 1000

type CacheEntry = {
  /** Last time we ran a Jupiter quote for this flow (ms epoch). */
  lastQuoteAt: number
  /** Last time we saw the cancel fingerprint at all (used for eviction). */
  lastSeenAt: number
}

const quotePreviewCache = new Map<string, CacheEntry>()

/**
 * Drops entries the daemon hasn't touched in `2 × TTL`. Called
 * opportunistically on every access — O(n) but `n` is bounded by
 * `MAX_CACHE_ENTRIES` so this is O(1000) worst case.
 */
function evictStale(nowMs: number): void {
  const cutoff = nowMs - 2 * QUOTE_PREVIEW_TTL_MS
  for (const [key, entry] of quotePreviewCache) {
    if (entry.lastSeenAt < cutoff) {
      quotePreviewCache.delete(key)
    }
  }
}

/**
 * Decide whether to fire a fresh Jupiter quote for this flow. Updates
 * the cache as a side effect: `lastSeenAt` always bumps, `lastQuoteAt`
 * only on `true`. Enforces eviction + cap.
 */
function shouldQuotePreview(flowKey: string, nowMs: number): boolean {
  evictStale(nowMs)

  // Hard cap. Drop the oldest-seen entry if we're at the limit and this
  // is a new flow. Map preserves insertion order, but `lastSeenAt` is
  // what we care about — a linear scan finds the true oldest.
  if (quotePreviewCache.size >= MAX_CACHE_ENTRIES && !quotePreviewCache.has(flowKey)) {
    let oldestKey: string | null = null
    let oldestSeenAt = Number.POSITIVE_INFINITY
    for (const [k, v] of quotePreviewCache) {
      if (v.lastSeenAt < oldestSeenAt) {
        oldestSeenAt = v.lastSeenAt
        oldestKey = k
      }
    }
    if (oldestKey !== null) {
      quotePreviewCache.delete(oldestKey)
    }
  }

  const existing = quotePreviewCache.get(flowKey)
  if (existing) {
    existing.lastSeenAt = nowMs
    if (nowMs - existing.lastQuoteAt < QUOTE_PREVIEW_TTL_MS) {
      return false
    }
    existing.lastQuoteAt = nowMs
    return true
  }
  quotePreviewCache.set(flowKey, { lastQuoteAt: nowMs, lastSeenAt: nowMs })
  return true
}

/** Test-only: empty the cache between cases. */
export function __resetCancelHandlerForTests(): void {
  quotePreviewCache.clear()
}

/** Test-only: introspect cache size for invariants. */
export function __cancelHandlerCacheSizeForTests(): number {
  return quotePreviewCache.size
}

export interface HandleCanceledRedemptionInput {
  flowKey: PublicKey
  trackerPda: PublicKey
  onycRefunded: bigint
  onycAmountIn: bigint
  /**
   * Injected quoter — the real implementation in production, a mock in
   * tests. Returning `null` means the caller already decided not to
   * quote (e.g. rate-limit), but in current usage the handler decides
   * internally and only invokes when needed.
   */
  runQuote: () => Promise<QuoteRedeemOnycRecoveryResult>
  log: Logger
  metrics: Metrics
  /** Override clock for tests. Defaults to `Date.now`. */
  nowMs?: number
}

export type HandleCanceledRedemptionResult = {
  /** Whether a Jupiter quote actually fired this tick. */
  quoted: boolean
  /** The quote's verdict if `quoted`, `null` otherwise. */
  decision: QuoteRedeemOnycRecoveryResult['decision'] | null
}

/**
 * Process one OnRe-cancel sighting: bump the per-flow counter, decide
 * whether to fire a Jupiter quote (rate-limited), shape the structured
 * preview log, and increment the appropriate metrics.
 *
 * Log levels:
 *  - First sighting per flow within the TTL window → `warn` (operators
 *    must see this — recovery is required).
 *  - Subsequent rate-limited ticks → `info` (the situation is known;
 *    the caller is just confirming the fingerprint is still present).
 *  This keeps `warn`-level log volume bounded at one per flow per
 *  `QUOTE_PREVIEW_TTL_MS` instead of one per ~30s scan tick.
 */
export async function handleCanceledRedemption(
  input: HandleCanceledRedemptionInput,
): Promise<HandleCanceledRedemptionResult> {
  const { flowKey, trackerPda, onycRefunded, onycAmountIn, runQuote, log, metrics } = input
  const nowMs = input.nowMs ?? Date.now()
  const flowKeyBase58 = flowKey.toBase58()

  metrics.redemptionCanceled.inc({ flow: flowKeyBase58 })

  const previewLog: Record<string, unknown> = {
    event: 'OnReRedemptionCanceled',
    flow: flowKeyBase58,
    tracker: trackerPda.toBase58(),
    onyc_refunded: onycRefunded.toString(),
    onyc_amount_in: onycAmountIn.toString(),
  }
  const recoveryAdvice = 'OnRe canceled redemption — operator must run scripts/recover-redeem-onyc.ts (router-agnostic, permissionless, NAV-anchored floor)'

  if (!shouldQuotePreview(flowKeyBase58, nowMs)) {
    previewLog.recovery_preview = 'rate_limited'
    // Drop to `info` once the operator has been alerted via the prior
    // `warn`. The fingerprint persisting is expected; only its first
    // sighting is news.
    log.info(recoveryAdvice, previewLog)
    return { quoted: false, decision: null }
  }

  const quote = await runQuote()
  applyQuoteToPreview(quote, previewLog, metrics)
  log.warn(recoveryAdvice, previewLog)
  return { quoted: true, decision: quote.decision }
}

/**
 * Folds a quote verdict into the structured preview log + bumps the
 * appropriate counter. The two axes are independent:
 *  - **Floor fields** (`nav_floor`, `gross_expected`) — present iff the
 *    on-chain Offer was reachable, i.e. any decision *other than*
 *    `offer_unavailable`.
 *  - **Outcome** — success path (clears/below-floor) vs. failure path
 *    (`quote_failed` / `offer_unavailable` both bump the same counter
 *    and surface a `reason` field).
 * Splitting along those axes means each field/metric is written once.
 */
function applyQuoteToPreview(
  quote: QuoteRedeemOnycRecoveryResult,
  previewLog: Record<string, unknown>,
  metrics: Metrics,
): void {
  previewLog.recovery_preview = quote.decision

  // Floor fields are defined whenever the Offer was reachable.
  if (quote.decision !== 'offer_unavailable') {
    previewLog.nav_floor = quote.navFloor.toString()
    previewLog.gross_expected = quote.grossExpected.toString()
  }

  if (quote.decision === 'quoted') {
    previewLog.quoted_out = quote.quotedOut.toString()
    previewLog.clears_floor = quote.clearsFloor
    previewLog.address_lookup_tables = quote.addressLookupTables.map(p => p.toBase58())
    const counter = quote.clearsFloor
      ? metrics.redeemOnycQuoteAboveFloor
      : metrics.redeemOnycQuoteBelowFloor
    counter.inc()
  } else {
    previewLog.reason = quote.reason
    metrics.redeemOnycQuoteFailed.inc()
  }
}
