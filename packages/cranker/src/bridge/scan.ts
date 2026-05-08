import type { ClassRollupAgg } from '../utils/log'
import type { WatermarkStore } from '../state/watermarks'
import type { BridgeContext, BridgeRedeemResult, BridgeRedeemTarget } from './types'
import { WormholescanClient } from '@fogo-onre/sdk'
import { errorFields, recordErrorClass, rollupErrorClasses } from '../utils/log'
import { recordSeen } from '../state/watermarks'
import { runBounded } from '../utils/concurrency'
import { harvestVaaPages } from '../utils/wormholescan-pages'
import { executeBridgePlan, planBridgeRedeem } from './redeem'

export interface BridgeScanOptions {
  pageSize: number
  maxPages: number
  /**
   * Bridge-side concurrency budget — separate from `maxConcurrentAdvances`
   *  on the relayer-Flow scanner so a Wormholescan backfill can't starve
   *  normal Flow advances.
   */
  maxConcurrentRedeems: number
  /**
   * Per-iteration class-aggregator (same shape as scan.ts). Lets the
   * scanner emit a single info-level rollup per error class instead of
   * one warn per failing VAA, mirroring the Flow scanner's UX.
   */
  seenRedeemErrors?: Map<string, string>
  /**
   * Optional per-emitter watermark store (shared with the Flow
   * enumerator's instance is fine — keys are emitter-hex). When set,
   * paging stops at `lastSeen - BACKFILL_COUNT`.
   */
  watermarks?: WatermarkStore
  /**
   * Optional callback fired once after the iteration if at least one
   * VAA was successfully redeemed. Used to wake the daemon's sleep
   * early when the bridge is busy.
   */
  onProgress?: () => void
}

/**
 * Bridge-pipeline analogue of `scanAndAdvance`: poll Wormholescan for
 * recent VAAs from the target's source emitter, decide an action per
 * VAA via `planBridgeRedeem`, submit via `executeBridgePlan`. Bounded
 * concurrency, abort-aware, no exceptions out of the per-VAA path.
 *
 * The daemon wraps this in `Promise.allSettled` alongside the relayer
 * Flow scanner so a bridge-side bug can't poison the Flow cranker's
 * heartbeat / backoff.
 */
export async function scanAndRedeemBridge(
  ctx: BridgeContext,
  target: BridgeRedeemTarget,
  opts: BridgeScanOptions,
): Promise<void> {
  if (ctx.abortSignal.aborted) {
    throw new Error('bridge scan aborted before start')
  }

  const ws = new WormholescanClient({ baseUrl: ctx.wormholescanUrl })
  const iterFailures = new Map<string, ClassRollupAgg>()
  const knownClasses = new Set(opts.seenRedeemErrors?.keys() ?? [])

  // Collect work first — keeps Wormholescan paging linear and lets the
  // bounded worker pool do its job without interleaving HTTP and CPI.
  const vaas: { vaa: Uint8Array, sequence: bigint, txHash: string | null }[] = []
  const pages = harvestVaaPages({
    ws,
    chainId: target.sourceChainId,
    emitterHex: target.sourceEmitterHex,
    pageSize: opts.pageSize,
    maxPages: opts.maxPages,
    watermarks: opts.watermarks,
    abortSignal: ctx.abortSignal,
    onPageError: (page, err) => {
      ctx.log.warn('bridge wormholescan fetch failed', {
        target: target.name,
        page,
        ...errorFields(err),
      })
    },
  })
  for await (const items of pages) {
    for (const it of items) {
      vaas.push({ vaa: it.vaa, sequence: it.sequence, txHash: it.txHash })
    }
  }

  ctx.log.debug('bridge vaas enumerated', { target: target.name, count: vaas.length })

  let progress = false
  await runBounded(vaas, opts.maxConcurrentRedeems, ctx.abortSignal, async (item) => {
    const seqLabel = item.sequence.toString()
    const result = await planAndSubmit(ctx, target, item.vaa).catch((err): BridgeRedeemResult => ({
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    }))
    if (result.kind === 'submitted') {
      progress = true
    }
    // Watermark advances only on submitted/noop. An `error` outcome
    // leaves the floor untouched so the next scan retries this VAA —
    // dual to the relayer enumerator's "transient RPC blip → don't
    // record" rule. Errors here are usually transient (rate-limit,
    // RPC blip, simulation noise); permanently broken VAAs end up as
    // `noop` once the planner can prove they're unactionable.
    if (result.kind !== 'error' && opts.watermarks) {
      recordSeen(opts.watermarks, target.sourceChainId, target.sourceEmitterHex, item.sequence)
    }
    logBridgeResult(ctx, target.name, seqLabel, item.txHash, result, opts.seenRedeemErrors, iterFailures)
  })

  if (progress) {
    opts.onProgress?.()
  }

  for (const { klass, agg, isKnown } of rollupErrorClasses(iterFailures, knownClasses)) {
    const fields = {
      target: target.name,
      class: klass,
      count: agg.count,
      sampleSequence: agg.sampleKey,
      sampleMessage: agg.sampleMessage,
    }
    if (isKnown) {
      ctx.log.debug('bridge failure class observed (known)', fields)
    } else {
      ctx.log.info('bridge failure class observed', fields)
    }
  }
}

async function planAndSubmit(
  ctx: BridgeContext,
  target: BridgeRedeemTarget,
  vaaBytes: Uint8Array,
): Promise<BridgeRedeemResult> {
  const { plan } = await planBridgeRedeem(ctx, target, vaaBytes)
  return executeBridgePlan(ctx, target, plan, vaaBytes)
}

function logBridgeResult(
  ctx: BridgeContext,
  target: string,
  sequence: string,
  txHash: string | null,
  result: BridgeRedeemResult,
  seenErrors: Map<string, string> | undefined,
  iterFailures: Map<string, ClassRollupAgg>,
): void {
  switch (result.kind) {
    case 'submitted':
      ctx.log.info('bridge vaa redeemed', {
        target,
        sequence,
        sourceTxHash: txHash,
        action: result.action,
        signature: result.signature,
      })
      return
    case 'noop':
      ctx.log.debug('bridge vaa noop', { target, sequence, reason: result.reason })
      return
    case 'error': {
      const { klass, firstSeenOn } = recordErrorClass({
        err: result.error,
        sampleKey: sequence,
        seenErrors,
        iterFailures,
      })
      const fields = {
        target,
        sequence,
        sourceTxHash: txHash,
        class: klass,
        ...errorFields(result.error),
      }
      if (firstSeenOn !== undefined) {
        ctx.log.debug('bridge vaa redeem failed (known class)', { ...fields, firstSeenOn })
      } else {
        ctx.log.warn('bridge vaa redeem failed', fields)
      }
    }
  }
}
