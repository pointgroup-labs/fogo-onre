import type { ResolvedNttVaa, WormholescanVaa } from '@fogo-onre/sdk'
import type { PublicKey } from '@solana/web3.js'
import type { WatermarkStore } from '../state/watermarks'
import type { FlowStatus, ScannedFlow } from './scan'
import type { AdvanceContext } from './types'
import {
  decodeNttInboxItem,
  describeStatus,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  ONYC_MINT,
  resolveNttVaa,
  USDC_MINT,
  WormholescanClient,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { recordSeen } from '../state/watermarks'
import { BoundedMap } from '../utils/bounded-map'
import { errorFields, errorFieldsCompact } from '../utils/log'
import { harvestVaaPages } from '../utils/wormholescan-pages'
import { readSplTokenAmount } from './account-layouts'

/**
 * Cap on the per-enumerator memo of inbox-items proven `Closed`. A
 * `Closed` Flow is permanently terminal (the relayer's `send` closed the
 * PDA for rent), so caching it lets repeated backstop sweeps skip *all*
 * RPC reads for that VAA. 50k entries is ~hours of historical flows at
 * realistic volume; FIFO eviction at the cap only costs one re-derivation
 * the next time that ancient VAA is paged.
 */
const TERMINAL_CACHE_MAX = 50_000

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
 * managers, parses each to its `nttInboxItem`, and synthesizes its
 * current state by checking whether a Flow PDA exists on-chain:
 *
 *   - No Flow PDA → status = 'Pending'  (receive dispatch)
 *   - Flow exists → status = describeStatus(flow.status)
 *
 * The VAA leg (`deposit`/`withdraw`) rides on `ScannedFlow.direction`;
 * VAA bytes are carried through as `vaaHex` so the advance fns don't
 * need a second Wormholescan round-trip.
 */
export function makeEnumerator(opts: EnumerateOptions) {
  const ws = new WormholescanClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl })
  // Memo of inbox-items proven `Closed`. Lives across scans (incremental
  // *and* backstop) for the enumerator's lifetime so a flow the deep
  // backstop sweep re-pages every cycle costs zero RPC after the first.
  const terminalCache = new BoundedMap<string, true>(TERMINAL_CACHE_MAX)

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
          items.map(async item => scanWormholescanVaa(ctx, item, leg, terminalCache)),
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

    // Independent emitters (distinct Wormholescan queries, distinct Flow
    // PDAs, distinct watermark keys) — scan in parallel so a cold start
    // with no checkpoint backfills both legs in one round-trip window.
    await Promise.all([
      opts.fogoUsdcEmitterHex ? harvest(opts.fogoUsdcEmitterHex, 'deposit') : undefined,
      opts.fogoOnycEmitterHex ? harvest(opts.fogoOnycEmitterHex, 'withdraw') : undefined,
    ])
    ctx.log.debug('scan iteration enumerated', { flows: out.length })
    return out
  }
}

async function scanWormholescanVaa(
  ctx: AdvanceContext,
  item: WormholescanVaa,
  leg: VaaLeg,
  terminalCache: BoundedMap<string, true>,
): Promise<VaaResolution> {
  const resolved = resolveVaaForLeg(ctx, item.vaa, leg)
  if (!resolved) {
    // Non-NTT VAA from this emitter (or malformed bytes). Permanently
    // uninteresting — recording lets the floor advance past it.
    return { sequence: item.sequence, flow: null, recordable: true }
  }
  // Known-terminal short-circuit: a `Closed` Flow never reopens, so skip
  // both the Flow-PDA fetch and the inbox/ATA peek `classifyMissingFlow`
  // would do. This is what keeps the deep backstop sweep from re-reading
  // every historical flow each cycle (the 429 storm's main amplifier).
  const inboxKey = resolved.nttInboxItem.toBase58()
  if (terminalCache.has(inboxKey)) {
    return {
      sequence: item.sequence,
      flow: {
        pubkey: resolved.nttInboxItem,
        status: 'Closed',
        direction: leg,
        fogoTx: item.txHash ?? '',
        vaaHex: Buffer.from(item.vaa).toString('hex'),
      },
      recordable: true,
    }
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
    // `Undecodable` sentinel: `pickAdvanceForStatus` default-skips it (no
    // handler matches). The VAA is recordable — we've logged + emitted
    // metric — so the watermark moves past the stuck PDA.
    return {
      sequence: item.sequence,
      flow: {
        pubkey: resolved.nttInboxItem,
        status: 'Undecodable',
        direction: leg,
        fogoTx: item.txHash ?? '',
        vaaHex: Buffer.from(item.vaa).toString('hex'),
      },
      recordable: true,
    }
  }
  // Post-completion disambiguation for *both* legs. After the relayer's
  // `send` closes the Flow PDA, `fetchFlow` returns `missing` — identical
  // to the pre-`receive` state, where a generic NTT relayer has already
  // run the raw redeem (inbox `Released`) but the OnRe relayer hasn't
  // swept the unlocked tokens yet. A naive `null -> Pending` either
  // re-dispatches `receive` against an already-redeemed inbox-item (NTT
  // aborts `TransferCannotBeRedeemed 6008`) or — the inverse bug —
  // abandons a genuinely-pending flow as `Closed`. `classifyMissingFlow`
  // reads whether the unlocked tokens are still parked in the recipient
  // ATA to tell the two apart.
  let status: FlowStatus = flow ? (describeStatus(flow.status) as FlowStatus) : 'Pending'
  if (fetchOutcome === 'missing') {
    const terminal = await classifyMissingFlow(ctx, leg, resolved.nttInboxItem)
    if (terminal) {
      status = terminal
    }
  }
  // Memoize terminal flows so later sweeps short-circuit to zero reads.
  if (status === 'Closed') {
    terminalCache.set(inboxKey, true)
  }
  return {
    sequence: item.sequence,
    flow: {
      pubkey: resolved.nttInboxItem,
      status,
      direction: leg,
      fogoTx: item.txHash ?? '',
      vaaHex: Buffer.from(item.vaa).toString('hex'),
    },
    recordable: true,
  }
}

/**
 * Decide whether a Flow PDA that's *missing* on-chain is genuinely
 * pending (the OnRe relayer hasn't run `receive` yet) or terminal (the
 * relayer completed and closed the Flow for rent).
 *
 * The trap: a generic NTT relayer performs the raw `redeem` +
 * `release_inbound` independently of OnRe, so the inbox-item reads
 * `Released` in *both* states. `Released` alone is therefore not a
 * completion signal. The decisive signal is whether the unlocked tokens
 * still sit in the recipient ATA:
 *
 *   - ATA still holds >= the inbox amount → tokens unswept, the relayer's
 *     `receive` hasn't run → return `null` (caller's default `Pending`
 *     stands, `receive` is dispatched and sweeps them).
 *   - ATA swept (< amount, typically 0) → `send` already moved the funds
 *     onward and closed the Flow → `'Closed'`.
 *
 * Returns `null` (→ `Pending`) on every ambiguous outcome — inbox not
 * `Released`, missing, undecodable, or any RPC failure — so a transient
 * blip can never strand a genuinely-pending flow. A redundant `receive`
 * against a finished flow is the cheap failure (on-chain
 * `TransferCannotBeRedeemed 6008`, already classified as a known race);
 * abandoning a stuck flow as `Closed` is the expensive one.
 */
export async function classifyMissingFlow(
  ctx: AdvanceContext,
  leg: VaaLeg,
  nttInboxItem: PublicKey,
): Promise<FlowStatus | null> {
  let info: Awaited<ReturnType<AdvanceContext['connection']['getAccountInfo']>>
  try {
    info = await ctx.connection.getAccountInfo(nttInboxItem)
  } catch (err) {
    ctx.log.debug('inbox-item peek failed (transient) — defaulting to Pending', {
      leg,
      nttInboxItem: nttInboxItem.toBase58(),
      ...errorFieldsCompact(err),
    })
    return null
  }
  if (!info) {
    // No inbox-item yet — NTT `redeem` hasn't materialised it. Genuinely
    // pre-receive; let the default `Pending` stand.
    return null
  }
  let inbox: ReturnType<typeof decodeNttInboxItem>
  try {
    inbox = decodeNttInboxItem(Buffer.from(info.data))
  } catch (err) {
    ctx.log.debug('inbox-item present but undecodable — defaulting to Pending', {
      leg,
      nttInboxItem: nttInboxItem.toBase58(),
      ...errorFieldsCompact(err),
    })
    return null
  }
  if (inbox.releaseStatus.kind !== 'Released') {
    // Not released yet — genuinely pre-receive.
    return null
  }

  // Released. Distinguish "send completed & swept" from "raw-redeemed but
  // relayer hasn't swept yet" by reading the recipient ATA balance.
  const recvMint = leg === 'withdraw' ? ONYC_MINT : USDC_MINT
  const recipientAta = getAssociatedTokenAddressSync(recvMint, inbox.recipientAddress, true)
  let ataInfo: Awaited<ReturnType<AdvanceContext['connection']['getAccountInfo']>>
  try {
    ataInfo = await ctx.connection.getAccountInfo(recipientAta)
  } catch (err) {
    ctx.log.debug('recipient-ATA peek failed (transient) — defaulting to Pending', {
      leg,
      recipientAta: recipientAta.toBase58(),
      ...errorFieldsCompact(err),
    })
    return null
  }
  const parked = readSplTokenAmount(ataInfo?.data) ?? 0n
  if (parked >= inbox.amount) {
    // Tokens unlocked but not swept — the relayer `receive` still needs to
    // run. Leave it `Pending` so the cranker drives receive → swap → send.
    // Surface it: a healthy sweep clears within a scan or two, so sustained
    // growth of this counter is the stranded-flow alert.
    ctx.metrics.flowUnsweptObserved.inc({ leg })
    return null
  }
  return 'Closed'
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
