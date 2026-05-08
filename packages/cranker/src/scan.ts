import type { PublicKey } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './advance/types'
import * as advance from './advance'
import { errorClass, errorFields, errorMessage } from './log'
import { withTimeout } from './rpc'

export type AdvanceFns = {
  claimUsdc: typeof advance.claimUsdc
  swapUsdcToOnyc: typeof advance.swapUsdcToOnyc
  lockOnyc: typeof advance.lockOnyc
  unlockOnyc: typeof advance.unlockOnyc
  requestRedemption: typeof advance.requestRedemption
  claimRedemption: typeof advance.claimRedemption
  sendUsdcToUser: typeof advance.sendUsdcToUser
}

export type ScannedFlow = {
  pubkey: PublicKey
  /** Synthetic status: 'Pending' for VAAs without a Flow yet, else the Flow's on-chain status. */
  status: string
  /** Source-chain tx signature; may be empty if unknown. */
  fogoTx: string
  /** Pre-fetched VAA bytes hex-encoded — preferred over fogoTx to avoid a second Wormholescan round-trip. */
  vaaHex?: string
}

export type EnumerateFlowsFn = (ctx: AdvanceContext) => Promise<ScannedFlow[]>

export type ScanOptions = {
  maxConcurrentAdvances: number
  rpcTimeoutMs: number
  enumerateFlows?: EnumerateFlowsFn
  advanceFns?: AdvanceFns
  /** Optional skip counter — incremented when a Flow has a status the cranker cannot currently advance (e.g. withdraw-leg statuses gated on ONyc deploy). */
  skipCounter?: { inc: (labels: { reason: string }) => void }
  /**
   * Cross-iteration dedup state for `flow advance failed` warnings.
   * Keyed on **error class** (message with pubkeys/hex redacted), not
   * per-flow exact match — a single sender-side encoding bug can affect
   * 100 distinct flows whose error messages differ only in pubkey, and
   * we don't want 100 first-sighting warns. The first sighting of a
   * class anywhere in the process logs at warn (with example flow);
   * every subsequent hit logs at debug. The per-iteration rollup
   * (emitted after `runBounded`) keeps the operator informed of how
   * many flows are still hitting each known class.
   *
   * Value = the flow key where this class was first observed (kept so
   * the warn line includes a concrete pointer for triage).
   *
   * Owned by the daemon (one Map per process); passed in so this module
   * stays free of module-level mutable state and stays unit-testable.
   */
  seenAdvanceErrors?: Map<string, string>
}

const DEFAULT_ADVANCE_FNS: AdvanceFns = {
  claimUsdc: advance.claimUsdc,
  swapUsdcToOnyc: advance.swapUsdcToOnyc,
  lockOnyc: advance.lockOnyc,
  unlockOnyc: advance.unlockOnyc,
  requestRedemption: advance.requestRedemption,
  claimRedemption: advance.claimRedemption,
  sendUsdcToUser: advance.sendUsdcToUser,
}

const defaultEnumerateFlows: EnumerateFlowsFn = async () => []

export async function scanAndAdvance(
  ctx: AdvanceContext,
  opts: ScanOptions,
): Promise<void> {
  if (ctx.abortSignal.aborted) {
    throw new Error('scan aborted before start')
  }

  const fns = opts.advanceFns ?? DEFAULT_ADVANCE_FNS
  const enumerate = opts.enumerateFlows ?? defaultEnumerateFlows

  const flows = await withTimeout(
    enumerate(ctx),
    opts.rpcTimeoutMs,
    'enumerateFlows',
  )

  ctx.log.debug('flows enumerated', { total: flows.length })

  // Per-iteration class → {count, sampleFlow, sampleMessage}. Built up by
  // logAdvanceResult during dispatch; emitted as one rollup per class
  // after runBounded.
  const iterationFailures = new Map<string, { count: number, sampleFlow: string, sampleMessage: string }>()

  // Snapshot of the cross-iter memo's class set BEFORE this scan. Used to
  // distinguish classes that were observed for the first time this scan
  // (rollup at info — novel signal worth surfacing) from classes the
  // operator was already notified about on a prior scan (rollup at debug —
  // suppress recurring noise; if they want the count they can grep).
  const knownClassesAtStart = new Set(opts.seenAdvanceErrors?.keys() ?? [])

  const tasks: Array<() => Promise<AdvanceResult>> = []
  for (const flow of flows) {
    const dispatch = pickAdvanceForStatus(flow.status, fns)
    if (!dispatch) {
      ctx.log.debug('flow skipped', {
        flow: flow.pubkey.toBase58(),
        status: flow.status || 'unknown',
      })
      opts.skipCounter?.inc({ reason: flow.status || 'unknown' })
      continue
    }
    const flowKey = flow.pubkey.toBase58()
    tasks.push(async () => {
      ctx.log.debug('dispatching advance', { flow: flowKey, status: flow.status })
      const result = await dispatch(ctx, { fogoTx: flow.fogoTx, vaaHex: flow.vaaHex })
      logAdvanceResult(ctx, flowKey, flow.status, result, opts.seenAdvanceErrors, iterationFailures)
      return result
    })
  }

  await runBounded(tasks, opts.maxConcurrentAdvances, ctx.abortSignal, ctx.log)

  // Iteration-level rollup. New classes (first appearance this process)
  // promote to info — pairs with the inline first-sighting warn so the
  // operator gets "this is the failure + here's how widespread it is in
  // this scan". Already-known classes drop to debug; per-scan recurrence
  // is the boring case and shouldn't keep paging into the operator's eye.
  for (const [klass, agg] of iterationFailures) {
    if (agg.count <= 1) {
      continue
    }
    const fields = {
      class: klass,
      count: agg.count,
      sampleFlow: agg.sampleFlow,
      sampleMessage: agg.sampleMessage,
    }
    if (knownClassesAtStart.has(klass)) {
      ctx.log.debug('advance failure class observed (known)', fields)
    } else {
      ctx.log.info('advance failure class observed', fields)
    }
  }
}

function logAdvanceResult(
  ctx: AdvanceContext,
  flow: string,
  fromStatus: string,
  result: AdvanceResult,
  seenErrors?: Map<string, string>,
  iterationFailures?: Map<string, { count: number, sampleFlow: string, sampleMessage: string }>,
): void {
  switch (result.kind) {
    case 'advanced':
      ctx.log.info('flow advanced', {
        flow,
        from: result.fromStatus,
        to: result.toStatus,
        signatures: result.signatures,
      })
      // No memo touch: class-level dedup means success on flow X doesn't
      // imply class C is gone — other flows may still be hitting it. The
      // per-iteration rollup is the operator's signal that the class is
      // (or isn't) recurring.
      return
    case 'noop':
      // Routine: another cranker advanced first, or pre-flight rejected.
      ctx.log.debug('flow noop', { flow, status: fromStatus, reason: result.reason })
      return
    case 'error': {
      // Per-flow failures are warnings, not errors — the next scan retries.
      // The scan-loop-level `error` log is reserved for whole-iteration failures.
      // Class-level dedup: pubkeys/hex redacted from the message so 100
      // distinct flows hitting the same sender-side bug produce one warn,
      // not 100. Subsequent hits log debug; rollup surfaces total count.
      const klass = errorClass(result.error)
      const previously = seenErrors?.get(klass)
      const isKnownClass = previously !== undefined
      const fields = {
        flow,
        status: fromStatus,
        partialSignatures: result.partialSignatures,
        class: klass,
        ...errorFields(result.error),
      }
      if (isKnownClass) {
        ctx.log.debug('flow advance failed (known class)', { ...fields, firstSeenOn: previously })
      } else {
        ctx.log.warn('flow advance failed', fields)
        seenErrors?.set(klass, flow)
      }
      const agg = iterationFailures?.get(klass)
      if (agg) {
        agg.count += 1
      } else {
        iterationFailures?.set(klass, {
          count: 1,
          sampleFlow: flow,
          sampleMessage: errorMessage(result.error),
        })
      }
    }
  }
}

type DispatchFn = (
  ctx: AdvanceContext,
  input: { fogoTx: string, vaaHex?: string },
) => Promise<AdvanceResult>

function pickAdvanceForStatus(status: string, fns: AdvanceFns): DispatchFn | undefined {
  switch (status) {
    case 'Pending':
      return fns.claimUsdc
    case 'Claimed':
      return fns.swapUsdcToOnyc
    case 'Swapped':
      return fns.lockOnyc
    // Withdraw-chain dispatches added when those advance fns are implemented:
    //   case 'RedemptionPending': return fns.claimRedemption
    //   case 'RedemptionSettled': return fns.sendUsdcToUser
    default:
      return undefined
  }
}

async function runBounded<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal: AbortSignal,
  log?: { warn: (msg: string, fields?: Record<string, unknown>) => void },
): Promise<void> {
  let i = 0
  let aborted = false
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) {
      if (signal.aborted) {
        aborted = true
        return
      }
      const idx = i++
      // Advance fns are contractually no-throw (they map errors into AdvanceResult.error).
      // A throw here is a bug; surface it instead of swallowing.
      await tasks[idx]().catch((err) => {
        log?.warn('runBounded task threw (advance contract violation)', errorFields(err))
      })
    }
  })
  await Promise.all(workers)
  if (aborted) {
    throw new Error('scan aborted mid-flight')
  }
}
