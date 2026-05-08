import type { BridgeContext, BridgeRedeemResult, BridgeRedeemTarget } from './types'
import { WormholescanClient } from '@fogo-onre/sdk'
import { errorClass, errorFields, errorMessage } from '../log'
import { executeBridgePlan, planBridgeRedeem } from './redeem'

export interface BridgeScanOptions {
  pageSize: number
  maxPages: number
  /** Bridge-side concurrency budget — separate from `maxConcurrentAdvances`
   *  on the relayer-Flow scanner so a Wormholescan backfill can't starve
   *  normal Flow advances. */
  maxConcurrentRedeems: number
  /**
   * Per-iteration class-aggregator (same shape as scan.ts). Lets the
   * scanner emit a single info-level rollup per error class instead of
   * one warn per failing VAA, mirroring the Flow scanner's UX.
   */
  seenRedeemErrors?: Map<string, string>
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
  const iterFailures = new Map<string, { count: number, sampleSeq: string, sampleMessage: string }>()
  const knownClasses = new Set(opts.seenRedeemErrors?.keys() ?? [])

  // Collect work first — keeps Wormholescan paging linear and lets the
  // bounded worker pool do its job without interleaving HTTP and CPI.
  const vaas: { vaa: Uint8Array, sequence: bigint, txHash: string | null }[] = []
  for (let page = 0; page < opts.maxPages; page++) {
    if (ctx.abortSignal.aborted) {
      return
    }
    const items = await ws.listVaasByEmitter(target.sourceChainId, target.sourceEmitterHex, {
      pageSize: opts.pageSize,
      page,
    }).catch((err) => {
      ctx.log.warn('bridge wormholescan fetch failed', {
        target: target.name,
        page,
        ...errorFields(err),
      })
      return []
    })
    if (items.length === 0) {
      break
    }
    for (const it of items) {
      vaas.push({ vaa: it.vaa, sequence: it.sequence, txHash: it.txHash })
    }
  }

  ctx.log.debug('bridge vaas enumerated', { target: target.name, count: vaas.length })

  await runBounded(vaas, opts.maxConcurrentRedeems, ctx.abortSignal, async (item) => {
    const seqLabel = item.sequence.toString()
    const result = await planAndSubmit(ctx, target, item.vaa).catch((err): BridgeRedeemResult => ({
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    }))
    logBridgeResult(ctx, target.name, seqLabel, item.txHash, result, opts.seenRedeemErrors, iterFailures)
  })

  for (const [klass, agg] of iterFailures) {
    if (agg.count <= 1) {
      continue
    }
    const fields = {
      target: target.name,
      class: klass,
      count: agg.count,
      sampleSequence: agg.sampleSeq,
      sampleMessage: agg.sampleMessage,
    }
    if (knownClasses.has(klass)) {
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
  iterFailures: Map<string, { count: number, sampleSeq: string, sampleMessage: string }>,
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
      const klass = errorClass(result.error)
      const previously = seenErrors?.get(klass)
      const fields = {
        target,
        sequence,
        sourceTxHash: txHash,
        class: klass,
        ...errorFields(result.error),
      }
      if (previously !== undefined) {
        ctx.log.debug('bridge vaa redeem failed (known class)', { ...fields, firstSeenOn: previously })
      } else {
        ctx.log.warn('bridge vaa redeem failed', fields)
        seenErrors?.set(klass, sequence)
      }
      const agg = iterFailures.get(klass)
      if (agg) {
        agg.count += 1
      } else {
        iterFailures.set(klass, {
          count: 1,
          sampleSeq: sequence,
          sampleMessage: errorMessage(result.error),
        })
      }
    }
  }
}

async function runBounded<T>(
  items: T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      if (signal.aborted) {
        return
      }
      const idx = i++
      await worker(items[idx])
    }
  })
  await Promise.all(workers)
}
