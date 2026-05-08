import type { PublicKey } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './types'
import type { ClassRollupAgg } from '../utils/log'
import type { FlowStateTracker } from '../state/flow-state'
import { claimUsdc } from './claim-usdc'
import { lockOnyc } from './lock-onyc'
import { swapUsdcToOnyc } from './swap-usdc-to-onyc'
import { errorClass, errorFields, recordErrorClass, rollupErrorClasses } from '../utils/log'
import { runBounded } from '../utils/concurrency'
import { withTimeout } from '../utils/rpc'

/**
 * Flow lifecycle states the cranker recognises. Mirrors the on-chain
 * `FlowStatus` enum (`programs/relayer/src/state.rs`) plus the synthetic
 * `Pending` value used for VAAs that don't yet have a Flow PDA.
 *
 * Centralised here so leg handlers, scan dispatch, and tests share the
 * exact same vocabulary — typo'd statuses become compile errors instead
 * of silent skip-paths through `pickAdvanceForStatus`'s default branch.
 */
export const FLOW_STATUSES = ['Pending', 'Claimed', 'Swapped', 'Locked', 'Closed'] as const
export type FlowStatus = typeof FLOW_STATUSES[number]

export type AdvanceFns = {
  claimUsdc: typeof claimUsdc
  swapUsdcToOnyc: typeof swapUsdcToOnyc
  lockOnyc: typeof lockOnyc
}

export type ScannedFlow = {
  pubkey: PublicKey
  /**
   * Synthetic `Pending` for VAAs without a Flow PDA yet, else the on-chain
   * `FlowStatus`. Unrecognised values may still flow through (forward-compat
   * with on-chain enum additions); they fall through `pickAdvanceForStatus`
   * to the default skip branch.
   */
  status: FlowStatus | string
  /** Source-chain tx signature; may be empty if unknown. */
  fogoTx: string
  /** Pre-fetched VAA bytes hex-encoded — preferred over fogoTx to avoid a second Wormholescan round-trip. */
  vaaHex?: string
}

export type EnumerateFlowsFn = (ctx: AdvanceContext) => Promise<ScannedFlow[]>

export type ScanOptions = {
  maxConcurrentAdvances: number
  rpcTimeoutMs: number
  /**
   * Budget for the `enumerateFlows` call. Separate from `rpcTimeoutMs`
   * because enumeration covers a full page window of Wormholescan +
   * per-VAA Flow PDA lookups; a 15s RPC budget is too tight on initial
   * backfill. Defaults to `rpcTimeoutMs` for back-compat with tests.
   */
  enumerateTimeoutMs?: number
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
  /**
   * Optional per-flow processing-state tracker. Gates dispatch so a
   * flow whose previous tx is still in flight (or that has been
   * cooling down after a recent error, or that has been quarantined as
   * poisoned) is skipped this tick — saving the RPC + sim cost. The
   * on-chain Flow PDA remains the source of truth; this is a pure
   * latency / load optimization. Without it, behavior matches the old
   * "always dispatch" path (used by tests that don't care).
   */
  flowState?: FlowStateTracker
  /**
   * Optional callback fired once after the iteration if at least one
   * flow advanced (`AdvanceResult.kind === 'advanced'`). Used to wake
   * the daemon's sleep early — when the chain is busy, the next tick
   * should run sooner than the 30s floor.
   */
  onProgress?: () => void
}

const DEFAULT_ADVANCE_FNS: AdvanceFns = {
  claimUsdc,
  swapUsdcToOnyc,
  lockOnyc,
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
    opts.enumerateTimeoutMs ?? opts.rpcTimeoutMs,
    'enumerateFlows',
  )

  ctx.log.debug('flows enumerated', { total: flows.length })

  // Per-iteration class → ClassRollupAgg, populated by logAdvanceResult
  // during dispatch and emitted as one rollup per class after runBounded.
  const iterationFailures = new Map<string, ClassRollupAgg>()

  // Snapshot of the cross-iter memo's class set BEFORE this scan. Used to
  // distinguish classes that were observed for the first time this scan
  // (rollup at info — novel signal worth surfacing) from classes the
  // operator was already notified about on a prior scan (rollup at debug —
  // suppress recurring noise; if they want the count they can grep).
  const knownClassesAtStart = new Set(opts.seenAdvanceErrors?.keys() ?? [])

  const tasks: Array<() => Promise<AdvanceResult>> = []
  let progress = false
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
    // Per-flow FSM gate: skip flows that are already in flight, in
    // cooldown after a recent error, or quarantined as poisoned. Saves
    // the RPC + sim cost on flows that are guaranteed to be wasted work
    // this tick. The on-chain Flow PDA remains the truth; this is purely
    // about whether *this cranker* should re-dispatch *this iteration*.
    if (opts.flowState) {
      const decision = opts.flowState.beginIfReady(flowKey)
      if (!decision.allowed) {
        ctx.log.debug('flow gated', { flow: flowKey, reason: decision.reason })
        opts.skipCounter?.inc({ reason: `gated:${decision.reason ?? 'unknown'}` })
        continue
      }
    }
    tasks.push(async () => {
      // Chain legs in-tick: a flow that progresses Pending → Claimed →
      // Swapped → Locked shouldn't pay one scan-interval (and one full
      // re-enumerate) per leg. We hold the FSM in-flight slot for the
      // whole chain — releasing it between legs would let another task
      // in this same tick race us on the same flow. Loop terminates on
      // first non-`advanced` result, on abort, or when the new status
      // has no successor dispatch.
      let currentStatus = flow.status
      let lastResult: AdvanceResult = {
        kind: 'noop',
        reason: `no dispatch for status ${flow.status}`,
      }
      let nextDispatch: DispatchFn | undefined = dispatch
      while (nextDispatch) {
        if (ctx.abortSignal.aborted) {
          break
        }
        ctx.log.debug('dispatching advance', { flow: flowKey, status: currentStatus })
        const result = await nextDispatch(ctx, { fogoTx: flow.fogoTx, vaaHex: flow.vaaHex })
        logAdvanceResult(ctx, flowKey, currentStatus, result, opts.seenAdvanceErrors, iterationFailures)
        lastResult = result
        if (result.kind !== 'advanced') {
          break
        }
        progress = true
        currentStatus = result.toStatus
        nextDispatch = pickAdvanceForStatus(currentStatus, fns)
      }
      if (opts.flowState) {
        if (lastResult.kind === 'error') {
          opts.flowState.recordError(flowKey, errorClass(lastResult.error))
        } else {
          opts.flowState.recordSuccess(flowKey)
        }
      }
      return lastResult
    })
  }

  await runBounded(
    tasks,
    opts.maxConcurrentAdvances,
    ctx.abortSignal,
    async task => task(),
    {
      throwOnAbort: true,
      // Advance fns are contractually no-throw (they map errors into
      // AdvanceResult.error). A throw here is a bug; surface it instead
      // of swallowing.
      onWorkerThrow: err => ctx.log.warn(
        'runBounded task threw (advance contract violation)',
        errorFields(err),
      ),
    },
  )

  if (progress) {
    opts.onProgress?.()
  }

  // Iteration-level rollup. New classes (first appearance this process)
  // promote to info — pairs with the inline first-sighting warn so the
  // operator gets "this is the failure + here's how widespread it is in
  // this scan". Already-known classes drop to debug; per-scan recurrence
  // is the boring case and shouldn't keep paging into the operator's eye.
  for (const { klass, agg, isKnown } of rollupErrorClasses(iterationFailures, knownClassesAtStart)) {
    const fields = {
      class: klass,
      count: agg.count,
      sampleFlow: agg.sampleKey,
      sampleMessage: agg.sampleMessage,
    }
    if (isKnown) {
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
  iterationFailures?: Map<string, ClassRollupAgg>,
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
      if (!iterationFailures) {
        return
      }
      const { klass, firstSeenOn } = recordErrorClass({
        err: result.error,
        sampleKey: flow,
        seenErrors,
        iterFailures: iterationFailures,
      })
      const fields = {
        flow,
        status: fromStatus,
        partialSignatures: result.partialSignatures,
        class: klass,
        ...errorFields(result.error),
      }
      if (firstSeenOn !== undefined) {
        ctx.log.debug('flow advance failed (known class)', { ...fields, firstSeenOn })
      } else {
        ctx.log.warn('flow advance failed', fields)
      }
    }
  }
}

type DispatchFn = (
  ctx: AdvanceContext,
  input: { fogoTx: string, vaaHex?: string },
) => Promise<AdvanceResult>

function pickAdvanceForStatus(status: FlowStatus | string, fns: AdvanceFns): DispatchFn | undefined {
  switch (status) {
    case 'Pending':
      return fns.claimUsdc
    case 'Claimed':
      return fns.swapUsdcToOnyc
    case 'Swapped':
      return fns.lockOnyc
    default:
      // 'Locked', 'Closed', or any forward-compat on-chain status the
      // cranker doesn't drive. Caller skips + bumps the `flow_skipped`
      // counter with `reason = status`.
      return undefined
  }
}
