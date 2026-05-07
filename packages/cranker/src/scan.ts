import type { PublicKey } from '@solana/web3.js'
import * as advance from './advance'
import type { AdvanceContext, AdvanceResult } from './advance/types'
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
  /** Source-chain tx signature used by advance fns to fetch the VAA. */
  fogoTx: string
}

export type EnumerateFlowsFn = (ctx: AdvanceContext) => Promise<ScannedFlow[]>

export type ScanOptions = {
  maxConcurrentAdvances: number
  rpcTimeoutMs: number
  enumerateFlows?: EnumerateFlowsFn
  advanceFns?: AdvanceFns
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

/**
 * Production enumerator stub. Real implementation will use
 * `getProgramAccounts` with discriminator + status memcmp filters
 * against the relayer program ID, plus a Wormholescan poll for VAAs
 * without on-chain Flow accounts yet (Pending state).
 *
 * TODO(scan): implement real PDA enumeration. Currently returns empty
 * so the daemon main loop can wire end-to-end and tests can inject
 * fake flow lists.
 */
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
      continue
    }
    tasks.push(() => dispatch(ctx, { fogoTx: flow.fogoTx }))
  }

  await runBounded(tasks, opts.maxConcurrentAdvances, ctx.abortSignal)
}

function pickAdvanceForStatus(
  status: string,
  fns: AdvanceFns,
): ((ctx: AdvanceContext, input: { fogoTx: string }) => Promise<AdvanceResult>) | undefined {
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
