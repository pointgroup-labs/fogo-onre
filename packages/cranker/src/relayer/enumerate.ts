import type { FlowStatusName, ResolvedNttVaa, WormholescanVaa } from '@fogo-onre/sdk'
import type { AdvanceContext } from './types'
import type { FlowStatus, ScannedFlow } from './scan'
import type { WatermarkStore } from '../state/watermarks'
import {
  describeStatus,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  resolveNttVaa,
  WormholescanClient,
} from '@fogo-onre/sdk'
import { errorFields, errorFieldsCompact } from '../utils/log'
import { recordSeen } from '../state/watermarks'
import { harvestVaaPages } from '../utils/wormholescan-pages'

const VAA_LEG = {
  deposit: { nttProgramId: NTT_USDC_PROGRAM_ID },
  withdraw: { nttProgramId: NTT_ONYC_PROGRAM_ID },
} as const

type VaaLeg = keyof typeof VAA_LEG

export type EnumerateOptions = {
  fogoWormholeChainId: number
  fogoUsdcEmitterHex?: string
  fogoOnycEmitterHex?: string
  pageSize: number
  maxPages: number
  baseUrl: string
  fetchImpl?: typeof fetch
  /**
   * Optional per-(chain, emitter) watermark store. When provided,
   * paging stops once an entire page sits at-or-below `lastSeen -
   * BACKFILL_COUNT` and watermarks are advanced *only* for VAAs that
   * the enumerator was able to resolve fully (no transient RPC blip
   * mid-fetch). Without it, behavior matches the old "page until empty,
   * record nothing" path.
   */
  watermarks?: WatermarkStore
}

/**
 * Per-VAA resolution outcome. The `recordable` bit decides whether the
 * watermark may advance past this sequence:
 *
 *   - non-NTT VAA → `flow=null, recordable=true` (permanently uninteresting)
 *   - account missing on-chain → `flow=ScannedFlow(Pending), recordable=true`
 *   - resolved Flow → `flow=ScannedFlow(<status>), recordable=true`
 *   - transient RPC error mid-fetch → `flow=null, recordable=false`
 *     (don't advance the floor — this VAA was *not* observed cleanly,
 *     so the next scan must keep paging it)
 */
type VaaResolution = {
  sequence: bigint
  flow: ScannedFlow | null
  recordable: boolean
}

/**
 * Polls Wormholescan for recent VAAs from the FOGO USDC and ONyc NTT
 * managers, parses each to a deposit-leg `nttInboxItem`, and synthesizes
 * its current state by checking whether a Flow PDA exists on-chain:
 *
 *   - No Flow PDA → status = 'Pending'  (claim_usdc dispatch)
 *   - Flow exists → status = describeStatus(flow.status)
 *
 * VAA bytes are carried through as `vaaHex` so the advance fns don't
 * need a second Wormholescan round-trip.
 */
export function makeEnumerator(opts: EnumerateOptions) {
  const ws = new WormholescanClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl })

  return async function enumerateFlows(ctx: AdvanceContext): Promise<ScannedFlow[]> {
    const out: ScannedFlow[] = []
    ctx.log.debug('scan iteration starting', {
      chainId: opts.fogoWormholeChainId,
      pageSize: opts.pageSize,
      maxPages: opts.maxPages,
      usdcEmitter: Boolean(opts.fogoUsdcEmitterHex),
      onycEmitter: Boolean(opts.fogoOnycEmitterHex),
    })

    async function harvest(emitterHex: string, leg: VaaLeg): Promise<void> {
      const pages = harvestVaaPages({
        ws,
        chainId: opts.fogoWormholeChainId,
        emitterHex,
        pageSize: opts.pageSize,
        maxPages: opts.maxPages,
        watermarks: opts.watermarks,
        abortSignal: ctx.abortSignal,
        onPageError: (page, err) => {
          ctx.log.warn('wormholescan fetch failed', { leg, page, ...errorFields(err) })
        },
        onPageFetched: (page, count, floor) => {
          ctx.log.debug('wormholescan page fetched', { leg, page, count, floor: floor.toString() })
        },
      })
      for await (const items of pages) {
        // Per-VAA Flow PDA lookups are independent reads; fan them out so a
        // 50-item page costs ~1 RPC RTT, not 50.
        const resolutions = await Promise.all(
          items.map(async item => scanWormholescanVaa(ctx, item, leg)),
        )
        if (ctx.abortSignal.aborted) {
          return
        }
        for (const r of resolutions) {
          if (r.flow) {
            out.push(r.flow)
          }
          // Advance the watermark only for VAAs we observed cleanly.
          // A transient RPC blip leaves the watermark untouched so this
          // VAA stays inside the next scan's paging window.
          if (r.recordable && opts.watermarks) {
            recordSeen(opts.watermarks, opts.fogoWormholeChainId, emitterHex, r.sequence)
          }
        }
      }
    }

    if (opts.fogoUsdcEmitterHex) {
      await harvest(opts.fogoUsdcEmitterHex, 'deposit')
    }
    if (opts.fogoOnycEmitterHex) {
      await harvest(opts.fogoOnycEmitterHex, 'withdraw')
    }
    ctx.log.debug('scan iteration enumerated', { flows: out.length })
    return out
  }
}

async function scanWormholescanVaa(
  ctx: AdvanceContext,
  item: WormholescanVaa,
  leg: VaaLeg,
): Promise<VaaResolution> {
  const resolved = resolveVaaForLeg(ctx, item.vaa, leg)
  if (!resolved) {
    // Non-NTT VAA from this emitter (or malformed bytes). Permanently
    // uninteresting — recording lets the floor advance past it.
    return { sequence: item.sequence, flow: null, recordable: true }
  }
  // Distinguish three Flow PDA fetch outcomes. Anchor's `fetch` throws
  // a recognizable "Account does not exist" message when the PDA isn't
  // initialized — that's the routine "Pending, never claimed" signal
  // and is recordable. Anything else is a transient RPC error that
  // must NOT advance the watermark.
  //
  // Leg-aware: deposit flows live under `findInflightFlowPda`,
  // withdraw flows under `findOutflightFlowPda` — different seed
  // prefix, different PDA. Fetching the wrong one for a withdraw
  // would always 404 and stamp the VAA as `Pending` forever, even
  // after `unlock_onyc` initialized the outflight PDA.
  let fetchOutcome: 'resolved' | 'missing' | 'rpc-error' = 'rpc-error'
  const fetchFlow = leg === 'withdraw'
    ? ctx.client.fetchOutflightFlow.bind(ctx.client)
    : ctx.client.fetchInflightFlow.bind(ctx.client)
  const flow = await fetchFlow(resolved.nttInboxItem)
    .then((f) => {
      fetchOutcome = 'resolved'
      return f
    })
    .catch((err) => {
      if (isAccountMissingError(err)) {
        fetchOutcome = 'missing'
        return null
      }
      ctx.log.warn('fetchFlow failed (transient — watermark NOT advanced)', {
        leg,
        nttInboxItem: resolved.nttInboxItem.toBase58(),
        ...errorFields(err),
      })
      fetchOutcome = 'rpc-error'
      return null
    })
  if (fetchOutcome === 'rpc-error') {
    return { sequence: item.sequence, flow: null, recordable: false }
  }
  return {
    sequence: item.sequence,
    flow: {
      pubkey: resolved.nttInboxItem,
      status: synthesizeStatus(leg, flow ? describeStatus(flow.status) : null),
      fogoTx: item.txHash ?? '',
      vaaHex: Buffer.from(item.vaa).toString('hex'),
    },
    recordable: true,
  }
}

/**
 * Map the on-chain `(leg, FlowStatus)` pair to a synthetic status
 * string the cranker FSM dispatches on. The on-chain `FlowStatus` enum
 * is shared between deposit and withdraw legs (Borsh tag-stable per
 * `state.rs`'s `flow_status_borsh_tag_invariant` test), so status
 * alone cannot pick a handler — the deposit-leg `Claimed` means
 * "USDC swept" and routes to `swap_usdc_to_onyc`, while the
 * withdraw-leg `Claimed` means "ONyc unlocked" and routes to
 * `request_redemption_onyc`. Synthesizing leg-prefixed strings here
 * lets `pickAdvanceForStatus` stay a flat switch.
 *
 * `null` flow ⇒ "no Flow PDA exists yet" — the entry-point status for
 * either leg.
 */
function synthesizeStatus(
  leg: VaaLeg,
  status: FlowStatusName | null,
): FlowStatus {
  if (leg === 'deposit') {
    if (status === null) {
      return 'Pending'
    }
    if (status === 'Claimed') {
      return 'Claimed'
    }
    if (status === 'Swapped') {
      return 'Swapped'
    }
    // RedemptionPending or Unknown on a deposit-leg Flow shouldn't
    // happen — pass through verbatim so the dispatcher's default
    // skip + skip-counter labels it for triage.
    return status as FlowStatus
  }
  // withdraw
  if (status === null) {
    return 'WithdrawPending'
  }
  if (status === 'Claimed') {
    return 'WithdrawClaimed'
  }
  if (status === 'Swapped') {
    return 'WithdrawSwapped'
  }
  if (status === 'RedemptionPending') {
    return 'RedemptionPending'
  }
  return status as FlowStatus
}

function isAccountMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('Account does not exist or has no data')
}

function resolveVaaForLeg(ctx: AdvanceContext, vaaBytes: Uint8Array, leg: VaaLeg): ResolvedNttVaa | null {
  try {
    return resolveNttVaa({
      vaaBytes,
      nttProgramId: VAA_LEG[leg].nttProgramId,
    })
  } catch (err) {
    // Non-NTT VAAs from the same emitter (or malformed bytes) are skipped
    // silently in production-info mode; debug surfaces them for triage.
    // Use compact error fields (message only, no stack) — these fire on
    // every non-NTT VAA the emitter has ever published, often hundreds
    // per page, and the stack is identical/uninformative for all of them.
    ctx.log.debug('resolveNttVaa skipped', { leg, ...errorFieldsCompact(err) })
    return null
  }
}
