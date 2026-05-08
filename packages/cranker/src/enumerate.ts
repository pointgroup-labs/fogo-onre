import type { AdvanceContext } from './advance/types'
import type { ScannedFlow } from './scan'
import type { ResolvedNttVaa } from './vaa'
import type { WormholescanVaa } from './wormholescan'
import { NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID } from '@fogo-onre/sdk'
import { describeStatus } from './advance/helpers'
import { errorFields, errorFieldsCompact } from './log'
import { resolveNttVaa } from './vaa'
import { WormholescanClient } from './wormholescan'

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
}

/**
 * Real `enumerateFlows` implementation. Polls Wormholescan for recent
 * VAAs from the FOGO USDC and ONyc NTT managers, parses each to a
 * deposit-leg `nttInboxItem`, and synthesizes its current state by
 * checking whether a Flow PDA exists on-chain:
 *
 *   - No Flow PDA → status = 'Pending'  (claim_usdc dispatch)
 *   - Flow exists → status = describeStatus(flow.status)
 *
 * Each emitter is independent: if `FOGO_USDC_EMITTER_HEX` is unset
 * (mainnet config not yet finalized), deposit-leg flows aren't
 * enumerated. Same for `FOGO_ONYC_EMITTER_HEX` (ONyc deploy gate).
 *
 * The VAA bytes are carried through as `vaaHex` so the advance fns
 * don't need a second Wormholescan round-trip.
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
      for (let page = 0; page < opts.maxPages; page++) {
        if (ctx.abortSignal.aborted) {
          return
        }
        const items = await ws.listVaasByEmitter(opts.fogoWormholeChainId, emitterHex, {
          pageSize: opts.pageSize,
          page,
        }).catch((err) => {
          ctx.log.warn('wormholescan fetch failed', { leg, page, ...errorFields(err) })
          return [] as WormholescanVaa[]
        })
        ctx.log.debug('wormholescan page fetched', { leg, page, count: items.length })
        if (items.length === 0) {
          return
        }
        for (const item of items) {
          const flow = await scanWormholescanVaa(ctx, item, leg)
          if (ctx.abortSignal.aborted) {
            return
          }
          if (flow) {
            out.push(flow)
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
): Promise<ScannedFlow | null> {
  const resolved = resolveVaaForLeg(ctx, item.vaa, leg)
  if (!resolved) {
    return null
  }
  const flow = await ctx.client
    .fetchInflightFlow(resolved.nttInboxItem)
    .catch((err) => {
      // Anchor's `fetch` throws "Account does not exist or has no data"
      // when the Flow PDA isn't initialized — which is the routine
      // "Pending, never claimed" signal. Anything else is an RPC failure.
      if (isAccountMissingError(err)) {
        return null
      }
      ctx.log.warn('fetchInflightFlow failed', {
        leg,
        nttInboxItem: resolved.nttInboxItem.toBase58(),
        ...errorFields(err),
      })
      return null
    })
  return {
    pubkey: resolved.nttInboxItem,
    status: flow ? describeStatus(flow.status) : 'Pending',
    fogoTx: item.txHash ?? '',
    vaaHex: Buffer.from(item.vaa).toString('hex'),
  }
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
