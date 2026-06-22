/**
 * Refund driver loop: a separate pass (not the swap→send happy path) that
 * enumerates flows, keeps the `Received` ones, and dispatches `refund` for
 * any past `REFUND_TIMEOUT_SLOTS`. Modeled on `scanAndAdvance`'s
 * enumerate→bounded-dispatch structure, but single-handler and read-mostly:
 * the per-flow timeout gate lives inside `refund` itself, so a not-yet-due
 * flow is a cheap noop.
 *
 * Runs on its own (slow) cadence — refund is the exception path, so it
 * needn't share the fast swap/send tick. Pairs with `scanAndAdvance`: a flow
 * is driven to `Swapped` by the happy path OR refunded here, never both (the
 * on-chain status guard + flow close enforce exactly one terminal).
 */
import type { EnumerateFlowsFn } from './scan'
import type { AdvanceContext, AdvanceResult } from './types'
import { runBounded } from '../utils/concurrency'
import { errorClass, errorFields } from '../utils/log'
import { withTimeout } from '../utils/rpc'
import { refund } from './refund'

export type RefundScanOptions = {
  maxConcurrentRefunds: number
  rpcTimeoutMs: number
  enumerateTimeoutMs?: number
  enumerateFlows: EnumerateFlowsFn
  refundFn?: typeof refund
  /** Cross-iteration dedup of `refund failed` warnings, keyed on error class. */
  seenRefundErrors?: Map<string, string>
}

export async function scanAndRefund(
  ctx: AdvanceContext,
  opts: RefundScanOptions,
): Promise<void> {
  if (ctx.abortSignal.aborted) {
    throw new Error('refund scan aborted before start')
  }
  const refundFn = opts.refundFn ?? refund

  const flows = await withTimeout(
    opts.enumerateFlows(ctx),
    opts.enumerateTimeoutMs ?? opts.rpcTimeoutMs,
    'enumerateFlows(refund)',
  )
  const received = flows.filter(f => f.status === 'Received')
  ctx.log.debug('refund scan: Received flows enumerated', { total: received.length })

  const tasks = received.map(flow => async (): Promise<AdvanceResult> => {
    const result = await refundFn(ctx, { fogoTx: flow.fogoTx, vaaHex: flow.vaaHex, direction: flow.direction })
    logRefundResult(ctx, flow.pubkey.toBase58(), result, opts.seenRefundErrors)
    return result
  })

  await runBounded(
    tasks,
    opts.maxConcurrentRefunds,
    ctx.abortSignal,
    async (task) => {
      await task()
    },
    {
      throwOnAbort: true,
      onWorkerThrow: err => ctx.log.warn('refund task threw (advance contract violation)', errorFields(err)),
    },
  )
}

function logRefundResult(
  ctx: AdvanceContext,
  flow: string,
  result: AdvanceResult,
  seenErrors?: Map<string, string>,
): void {
  switch (result.kind) {
    case 'advanced':
      ctx.log.info('flow refunded', { flow, from: result.fromStatus, to: result.toStatus, signatures: result.signatures })
      return
    case 'noop':
      ctx.log.debug('refund noop', { flow, reason: result.reason })
      return
    case 'error': {
      const klass = errorClass(result.error)
      const firstSeenOn = seenErrors?.get(klass)
      if (firstSeenOn === undefined) {
        seenErrors?.set(klass, flow)
        ctx.log.warn('refund failed', { flow, class: klass, ...errorFields(result.error) })
      } else {
        ctx.log.debug('refund failed (known class)', { flow, class: klass, firstSeenOn, ...errorFields(result.error) })
      }
    }
  }
}
