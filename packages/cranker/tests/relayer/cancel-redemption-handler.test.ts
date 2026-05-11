import type { Metrics } from '../../src/metrics'
import type { QuoteRedeemOnycRecoveryResult } from '../../src/relayer/redeem-onyc-quote'
import type { Logger } from '../../src/utils/log'
import { PublicKey } from '@solana/web3.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __cancelHandlerCacheSizeForTests,
  __resetCancelHandlerForTests,
  handleCanceledRedemption,
  QUOTE_PREVIEW_TTL_MS,
} from '../../src/relayer/cancel-redemption-handler'

/**
 * These tests pin deploy-readiness invariants for the OnRe-cancel
 * fingerprint branch:
 *  - First sighting per flow → warn + quote.
 *  - Subsequent sightings within TTL → info + no quote (rate-limited).
 *  - Cache evicts stale entries; cache is hard-capped.
 *  - Each quote outcome (`quoted`/`quote_failed`/`offer_unavailable`)
 *    bumps exactly the counters it should and shapes the log
 *    accordingly.
 */

const FLOW_A = new PublicKey('11111111111111111111111111111112')
const FLOW_B = new PublicKey('11111111111111111111111111111113')
const TRACKER = new PublicKey('11111111111111111111111111111114')

type LogCall = { level: 'info' | 'warn', msg: string, fields: Record<string, unknown> }

function makeRecordingLog(into: LogCall[]): Logger {
  const noop = (): void => {}
  const self: Logger = {
    debug: noop,
    info: (msg, fields) => into.push({ level: 'info', msg, fields: { ...fields } as Record<string, unknown> }),
    warn: (msg, fields) => into.push({ level: 'warn', msg, fields: { ...fields } as Record<string, unknown> }),
    error: noop,
    fatal: noop,
    child: () => self,
  }
  return self
}

type Counters = {
  redemptionCanceled: number
  above: number
  below: number
  failed: number
}

function makeStubMetrics(c: Counters): Metrics {
  // Just the four counters this handler touches — `as unknown as Metrics`
  // because the full Metrics surface is huge and irrelevant here.
  return {
    redemptionCanceled: { inc: () => { c.redemptionCanceled += 1 } },
    redeemOnycQuoteAboveFloor: { inc: () => { c.above += 1 } },
    redeemOnycQuoteBelowFloor: { inc: () => { c.below += 1 } },
    redeemOnycQuoteFailed: { inc: () => { c.failed += 1 } },
  } as unknown as Metrics
}

const QUOTED_ABOVE: QuoteRedeemOnycRecoveryResult = {
  decision: 'quoted',
  navFloor: 995_000n,
  grossExpected: 1_000_000n,
  quotedOut: 999_000n,
  clearsFloor: true,
  addressLookupTables: [new PublicKey('11111111111111111111111111111115')],
  swapIxData: new Uint8Array(),
  swapAccounts: [],
}

const QUOTED_BELOW: QuoteRedeemOnycRecoveryResult = {
  ...QUOTED_ABOVE,
  quotedOut: 994_999n,
  clearsFloor: false,
}

const QUOTE_FAILED: QuoteRedeemOnycRecoveryResult = {
  decision: 'quote_failed',
  navFloor: 995_000n,
  grossExpected: 1_000_000n,
  reason: 'network down',
}

const OFFER_UNAVAILABLE: QuoteRedeemOnycRecoveryResult = {
  decision: 'offer_unavailable',
  reason: 'mint decimals unreadable',
}

beforeEach(() => {
  __resetCancelHandlerForTests()
})

afterEach(() => {
  __resetCancelHandlerForTests()
  vi.useRealTimers()
})

describe('handleCanceledRedemption', () => {
  it('first sighting fires a warn-level log + Jupiter quote + above-floor counter', async () => {
    const logs: LogCall[] = []
    const counters: Counters = { redemptionCanceled: 0, above: 0, below: 0, failed: 0 }
    const runQuote = vi.fn(async () => QUOTED_ABOVE)

    const result = await handleCanceledRedemption({
      flowKey: FLOW_A,
      trackerPda: TRACKER,
      onycRefunded: 1_000_000n,
      onycAmountIn: 1_000_000n,
      runQuote,
      log: makeRecordingLog(logs),
      metrics: makeStubMetrics(counters),
      nowMs: 1_700_000_000_000,
    })

    expect(result).toEqual({ quoted: true, decision: 'quoted' })
    expect(runQuote).toHaveBeenCalledTimes(1)
    expect(counters).toEqual({ redemptionCanceled: 1, above: 1, below: 0, failed: 0 })
    expect(logs).toHaveLength(1)
    expect(logs[0].level).toBe('warn')
    expect(logs[0].fields).toMatchObject({
      event: 'OnReRedemptionCanceled',
      flow: FLOW_A.toBase58(),
      tracker: TRACKER.toBase58(),
      recovery_preview: 'quoted',
      clears_floor: true,
      nav_floor: '995000',
      quoted_out: '999000',
      address_lookup_tables: ['11111111111111111111111111111115'],
    })
  })

  it('rate-limits per-flow within TTL: second tick logs info, fires no quote', async () => {
    const logs: LogCall[] = []
    const counters: Counters = { redemptionCanceled: 0, above: 0, below: 0, failed: 0 }
    const runQuote = vi.fn(async () => QUOTED_ABOVE)
    const log = makeRecordingLog(logs)
    const metrics = makeStubMetrics(counters)

    const t0 = 1_700_000_000_000
    await handleCanceledRedemption({
      flowKey: FLOW_A,
      trackerPda: TRACKER,
      onycRefunded: 1_000_000n,
      onycAmountIn: 1_000_000n,
      runQuote,
      log,
      metrics,
      nowMs: t0,
    })
    // Second tick 30s later — well under the 5min TTL.
    const second = await handleCanceledRedemption({
      flowKey: FLOW_A,
      trackerPda: TRACKER,
      onycRefunded: 1_000_000n,
      onycAmountIn: 1_000_000n,
      runQuote,
      log,
      metrics,
      nowMs: t0 + 30_000,
    })

    expect(second).toEqual({ quoted: false, decision: null })
    expect(runQuote).toHaveBeenCalledTimes(1) // still only the first call
    // redemptionCanceled fires every tick (operators want the count);
    // quote counters fire only on the actual quote.
    expect(counters).toEqual({ redemptionCanceled: 2, above: 1, below: 0, failed: 0 })
    expect(logs).toHaveLength(2)
    expect(logs[1].level).toBe('info')
    expect(logs[1].fields.recovery_preview).toBe('rate_limited')
  })

  it('re-quotes after the TTL window expires', async () => {
    const logs: LogCall[] = []
    const counters: Counters = { redemptionCanceled: 0, above: 0, below: 0, failed: 0 }
    const runQuote = vi.fn(async () => QUOTED_ABOVE)
    const log = makeRecordingLog(logs)
    const metrics = makeStubMetrics(counters)

    const t0 = 1_700_000_000_000
    await handleCanceledRedemption({ flowKey: FLOW_A, trackerPda: TRACKER, onycRefunded: 1n, onycAmountIn: 1n, runQuote, log, metrics, nowMs: t0 })
    await handleCanceledRedemption({ flowKey: FLOW_A, trackerPda: TRACKER, onycRefunded: 1n, onycAmountIn: 1n, runQuote, log, metrics, nowMs: t0 + QUOTE_PREVIEW_TTL_MS + 1 })

    expect(runQuote).toHaveBeenCalledTimes(2)
    expect(counters.above).toBe(2)
    expect(logs.filter(l => l.level === 'warn')).toHaveLength(2)
  })

  it('separate flows are tracked independently', async () => {
    const logs: LogCall[] = []
    const counters: Counters = { redemptionCanceled: 0, above: 0, below: 0, failed: 0 }
    const runQuote = vi.fn(async () => QUOTED_ABOVE)
    const log = makeRecordingLog(logs)
    const metrics = makeStubMetrics(counters)

    const t0 = 1_700_000_000_000
    await handleCanceledRedemption({ flowKey: FLOW_A, trackerPda: TRACKER, onycRefunded: 1n, onycAmountIn: 1n, runQuote, log, metrics, nowMs: t0 })
    await handleCanceledRedemption({ flowKey: FLOW_B, trackerPda: TRACKER, onycRefunded: 1n, onycAmountIn: 1n, runQuote, log, metrics, nowMs: t0 + 1_000 })

    expect(runQuote).toHaveBeenCalledTimes(2)
    expect(counters.above).toBe(2)
    expect(counters.redemptionCanceled).toBe(2)
  })

  it('quote_failed shape: bumps `failed`, keeps nav_floor in log, no above/below', async () => {
    const logs: LogCall[] = []
    const counters: Counters = { redemptionCanceled: 0, above: 0, below: 0, failed: 0 }

    await handleCanceledRedemption({
      flowKey: FLOW_A,
      trackerPda: TRACKER,
      onycRefunded: 1n,
      onycAmountIn: 1n,
      runQuote: async () => QUOTE_FAILED,
      log: makeRecordingLog(logs),
      metrics: makeStubMetrics(counters),
      nowMs: 1_700_000_000_000,
    })

    expect(counters).toEqual({ redemptionCanceled: 1, above: 0, below: 0, failed: 1 })
    expect(logs[0].fields).toMatchObject({
      recovery_preview: 'quote_failed',
      nav_floor: '995000',
      reason: 'network down',
    })
    expect(logs[0].fields).not.toHaveProperty('clears_floor')
  })

  it('offer_unavailable shape: bumps `failed`, omits nav_floor, surfaces reason', async () => {
    const logs: LogCall[] = []
    const counters: Counters = { redemptionCanceled: 0, above: 0, below: 0, failed: 0 }

    await handleCanceledRedemption({
      flowKey: FLOW_A,
      trackerPda: TRACKER,
      onycRefunded: 1n,
      onycAmountIn: 1n,
      runQuote: async () => OFFER_UNAVAILABLE,
      log: makeRecordingLog(logs),
      metrics: makeStubMetrics(counters),
      nowMs: 1_700_000_000_000,
    })

    expect(counters.failed).toBe(1)
    expect(logs[0].fields).toMatchObject({
      recovery_preview: 'offer_unavailable',
      reason: 'mint decimals unreadable',
    })
    expect(logs[0].fields).not.toHaveProperty('nav_floor')
  })

  it('below-floor verdict bumps the below counter, not above', async () => {
    const logs: LogCall[] = []
    const counters: Counters = { redemptionCanceled: 0, above: 0, below: 0, failed: 0 }

    await handleCanceledRedemption({
      flowKey: FLOW_A,
      trackerPda: TRACKER,
      onycRefunded: 1n,
      onycAmountIn: 1n,
      runQuote: async () => QUOTED_BELOW,
      log: makeRecordingLog(logs),
      metrics: makeStubMetrics(counters),
      nowMs: 1_700_000_000_000,
    })

    expect(counters).toEqual({ redemptionCanceled: 1, above: 0, below: 1, failed: 0 })
    expect(logs[0].fields).toMatchObject({ clears_floor: false })
  })

  it('cache evicts entries older than 2× TTL', async () => {
    // Seed FLOW_A at t0, then call FLOW_B at t0 + 2*TTL + 1 — the access
    // triggers eviction and FLOW_A is dropped because it hasn't been
    // touched in > 2*TTL.
    const logs: LogCall[] = []
    const counters: Counters = { redemptionCanceled: 0, above: 0, below: 0, failed: 0 }
    const runQuote = vi.fn(async () => QUOTED_ABOVE)
    const log = makeRecordingLog(logs)
    const metrics = makeStubMetrics(counters)

    const t0 = 1_700_000_000_000
    await handleCanceledRedemption({ flowKey: FLOW_A, trackerPda: TRACKER, onycRefunded: 1n, onycAmountIn: 1n, runQuote, log, metrics, nowMs: t0 })
    expect(__cancelHandlerCacheSizeForTests()).toBe(1)

    await handleCanceledRedemption({ flowKey: FLOW_B, trackerPda: TRACKER, onycRefunded: 1n, onycAmountIn: 1n, runQuote, log, metrics, nowMs: t0 + 2 * QUOTE_PREVIEW_TTL_MS + 1 })
    // FLOW_A evicted, FLOW_B added → still 1.
    expect(__cancelHandlerCacheSizeForTests()).toBe(1)
  })
})
