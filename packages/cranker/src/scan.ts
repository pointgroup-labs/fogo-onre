import type { PublicKey } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './advance/types'
import * as advance from './advance'
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

  const tasks: Array<() => Promise<AdvanceResult>> = []
  for (const flow of flows) {
    const dispatch = pickAdvanceForStatus(flow.status, fns)
    if (!dispatch) {
      opts.skipCounter?.inc({ reason: flow.status || 'unknown' })
      continue
    }
    tasks.push(() => dispatch(ctx, { fogoTx: flow.fogoTx, vaaHex: flow.vaaHex }))
  }

  await runBounded(tasks, opts.maxConcurrentAdvances, ctx.abortSignal)
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
      // Advance fns return AdvanceResult (never throw); .catch is defensive.
      await tasks[idx]().catch(() => undefined)
    }
  })
  await Promise.all(workers)
  if (aborted) {
    throw new Error('scan aborted mid-flight')
  }
}
