import type { FlowStatusName, ResolvedNttVaa, WormholescanVaa } from '@fogo-onre/sdk'
import type { PublicKey } from '@solana/web3.js'
import type { WatermarkStore } from '../state/watermarks'
import type { FlowStatus, ScannedFlow } from './scan'
import type { AdvanceContext } from './types'
import {
  decodeNttInboxItem,
  describeStatus,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  resolveNttVaa,
  WormholescanClient,
} from '@fogo-onre/sdk'
import { recordSeen } from '../state/watermarks'
import { errorFields, errorFieldsCompact } from '../utils/log'
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
  /**
   * Backstop mode. When true, the floor is forced to 0 — paging walks
   * the full `maxPages` window regardless of where the watermark sits,
   * and the recorded watermark is *not* updated. Used by the periodic
   * recovery scan to surface flows the incremental enumerator stranded:
   *
   *   - Daemon downtime crossed VAA arrival → incremental scan recorded
   *     a non-NTT skip OR fast-forwarded the floor past it on resume.
   *   - Post-watermark dispatch failed and the flow's status didn't
   *     change → incremental scan no longer pages its sequence.
   *
   * Backstop pairs naturally with a much larger `maxPages` (e.g. 50 vs
   * the incremental tick's 5) so it covers ~hours, not ~minutes.
   */
  bypassWatermark?: boolean
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
        bypassWatermark: opts.bypassWatermark,
        abortSignal: ctx.abortSignal,
        onPageError: (page, err) => {
          ctx.log.warn('wormholescan fetch failed', { leg, page, ...errorFields(err), backstop: Boolean(opts.bypassWatermark) })
        },
        onPageFetched: (page, count, floor) => {
          ctx.log.debug('wormholescan page fetched', { leg, page, count, floor: floor.toString(), backstop: Boolean(opts.bypassWatermark) })
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
          //
          // Backstop scans deliberately do *not* advance the watermark
          // — they're a recovery sweep over flows the incremental scan
          // already passed. Updating the watermark here would conflict
          // with the next incremental tick's view of "where I am."
          if (r.recordable && !opts.bypassWatermark && opts.watermarks) {
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
  // Distinguish four Flow PDA fetch outcomes:
  //   - `resolved`    — PDA exists and decoded cleanly under the current IDL.
  //   - `missing`     — Anchor's `fetch` threw "Account does not exist".
  //                     Routine "Pending, never claimed" signal; recordable.
  //   - `undecodable` — PDA exists but Borsh decode failed because the
  //                     on-chain bytes were written by an older relayer
  //                     version with `FlowStatus` variants the new IDL no
  //                     longer knows (typically post-upgrade pre-existing
  //                     flows). Structural, not transient — looping on it
  //                     wedges the scanner forever. Advance the watermark,
  //                     log loudly, bump `flowSkipped{reason="undecodable"}`
  //                     so the operator can triage the named PDA out-of-band.
  //   - `rpc-error`   — anything else: real transient RPC error. Watermark
  //                     stays put so the next poll retries.
  //
  // Leg-aware: deposit flows live under `findInflightFlowPda`,
  // withdraw flows under `findOutflightFlowPda` — different seed
  // prefix, different PDA. Fetching the wrong one for a withdraw
  // would always 404 and stamp the VAA as `Pending` forever, even
  // after `unlock_onyc` initialized the outflight PDA.
  let fetchOutcome: 'resolved' | 'missing' | 'undecodable' | 'rpc-error' = 'rpc-error'
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
      if (isUndecodableAccountError(err)) {
        ctx.log.warn('Flow PDA exists but is undecodable under current IDL — likely written by an older relayer version; advancing watermark, operator triage required', {
          leg,
          nttInboxItem: resolved.nttInboxItem.toBase58(),
          ...errorFieldsCompact(err),
        })
        ctx.metrics.flowSkipped.inc({ reason: 'undecodable' })
        fetchOutcome = 'undecodable'
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
  if (fetchOutcome === 'undecodable') {
    // Synthesize a leg-prefixed sentinel status so the FSM's
    // `pickAdvanceForStatus` default-skips it (no handler will ever
    // match an `*Undecodable` status). The VAA is recordable — we've
    // logged + emitted metric — so the watermark moves past it and
    // the scanner stops re-fetching the same stuck PDA on every poll.
    return {
      sequence: item.sequence,
      flow: {
        pubkey: resolved.nttInboxItem,
        status: leg === 'withdraw' ? 'WithdrawUndecodable' : 'DepositUndecodable',
        fogoTx: item.txHash ?? '',
        vaaHex: Buffer.from(item.vaa).toString('hex'),
      },
      recordable: true,
    }
  }
  // Withdraw-leg post-completion disambiguation. After `send_usdc_to_user`
  // closes the Flow PDA, `fetchOutflightFlow` returns `missing` — same as
  // the pre-`unlock_onyc` state — so a naive `null -> WithdrawPending`
  // classification re-dispatches `unlock_onyc` against an already-redeemed
  // NTT inbox-item, which NTT correctly aborts with
  // `TransferCannotBeRedeemed (6008)`. Peek the inbox-item's release_status
  // to break the ambiguity: `Released` means the chain is complete, route
  // to the terminal `WithdrawClosed` so `pickAdvanceForStatus` skips it.
  // Mirrors the deposit-side guard at `bridge/redeem.ts:134`.
  let synthesizedStatus = synthesizeStatus(leg, flow ? describeStatus(flow.status) : null)
  if (leg === 'withdraw' && fetchOutcome === 'missing') {
    const terminal = await classifyMissingWithdrawFlow(ctx, resolved.nttInboxItem)
    if (terminal) {
      synthesizedStatus = terminal
    }
  }
  return {
    sequence: item.sequence,
    flow: {
      pubkey: resolved.nttInboxItem,
      status: synthesizedStatus,
      fogoTx: item.txHash ?? '',
      vaaHex: Buffer.from(item.vaa).toString('hex'),
    },
    recordable: true,
  }
}

/**
 * Decide whether a withdraw-leg Flow PDA that's *missing* on-chain is
 * pre-`unlock_onyc` (genuinely pending) or post-`send_usdc_to_user`
 * (chain complete, Flow closed for rent).
 *
 * Returns `'WithdrawClosed'` only when we can affirmatively prove the NTT
 * inbox-item is `Released`. RPC failures and undecodable bytes return
 * `null`, leaving the caller's default `'WithdrawPending'` synthesis in
 * place — the on-chain handler will give the authoritative answer on the
 * next dispatch attempt (and the `TransferCannotBeRedeemed` it throws is
 * already classified as a known race elsewhere). This conservatism keeps
 * a transient RPC blip from hiding a genuinely-pending withdraw.
 */
async function classifyMissingWithdrawFlow(
  ctx: AdvanceContext,
  nttInboxItem: PublicKey,
): Promise<FlowStatus | null> {
  let info: Awaited<ReturnType<AdvanceContext['connection']['getAccountInfo']>>
  try {
    info = await ctx.connection.getAccountInfo(nttInboxItem)
  } catch (err) {
    ctx.log.debug('inbox-item peek failed (transient) — defaulting to WithdrawPending', {
      nttInboxItem: nttInboxItem.toBase58(),
      ...errorFieldsCompact(err),
    })
    return null
  }
  if (!info) {
    // No inbox-item exists yet — NTT `Redeem` hasn't materialised it.
    // Genuinely pre-unlock; let the default `WithdrawPending` stand.
    return null
  }
  try {
    const inboxState = decodeNttInboxItem(Buffer.from(info.data))
    if (inboxState.releaseStatus.kind === 'Released') {
      return 'WithdrawClosed'
    }
  } catch (err) {
    ctx.log.debug('inbox-item present but undecodable — defaulting to WithdrawPending', {
      nttInboxItem: nttInboxItem.toBase58(),
      ...errorFieldsCompact(err),
    })
  }
  return null
}

/**
 * Map the on-chain `(leg, FlowStatus)` pair to a synthetic status
 * string the cranker FSM dispatches on. The on-chain `FlowStatus` enum
 * is shared between deposit and withdraw legs (Borsh tag-stable per
 * `state.rs`'s `flow_status_borsh_tag_invariant` test), so status
 * alone cannot pick a handler — the deposit-leg `Claimed` means
 * "USDC swept" and routes to `swap_usdc_to_onyc`, while the
 * withdraw-leg `Claimed` means "ONyc unlocked" and routes to
 * `swap_onyc_to_usdc`. Synthesizing leg-prefixed strings here
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
    // Unknown on a deposit-leg Flow shouldn't happen — pass through
    // verbatim so the dispatcher's default skip + skip-counter labels
    // it for triage.
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
  return status as FlowStatus
}

function isAccountMissingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('Account does not exist or has no data')
}

/**
 * Recognise the failure mode where a `Flow` PDA exists on-chain but its
 * bytes don't match the IDL the cranker was built against. The canonical
 * stack is:
 *
 *   TypeError: Cannot read properties of null (reading 'property')
 *     at Union.decode (anchor's BorshAccountsCoder)
 *     at Structure.decode
 *     at BorshAccountsCoder.decode
 *
 * Trigger: a relayer upgrade removed `FlowStatus` enum variants that
 * pre-existing on-chain `Flow` PDAs still carry as their `status` tag
 * byte. Anchor's union decoder returns `null` for the unknown variant
 * and the next field-access crashes. This is permanent for that PDA —
 * no amount of retrying will change the on-chain bytes — so the scanner
 * must advance past it rather than wedge.
 *
 * Conservative match: require both a `TypeError` instance and an Anchor
 * Borsh-coder frame in the stack, so unrelated `TypeError`s from
 * elsewhere in the call graph aren't silently swept into "advance the
 * watermark".
 */
export function isUndecodableAccountError(err: unknown): boolean {
  if (!(err instanceof TypeError)) {
    return false
  }
  const stack = err.stack ?? ''
  return /BorshAccountsCoder|Union\.decode|Structure\.decode/.test(stack)
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
