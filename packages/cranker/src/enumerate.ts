import type { AdvanceContext } from './advance/types'
import type { ScannedFlow } from './scan'
import { NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID } from '@fogo-onre/sdk'
import { describeStatus } from './advance/helpers'
import { resolveNttVaa } from './vaa'
import { WormholescanClient } from './wormholescan'

const VAA_LEG = {
  deposit: { nttProgramId: NTT_USDC_PROGRAM_ID },
  withdraw: { nttProgramId: NTT_ONYC_PROGRAM_ID },
} as const

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

    const harvest = async (
      emitterHex: string,
      leg: keyof typeof VAA_LEG,
    ): Promise<void> => {
      for (let page = 0; page < opts.maxPages; page++) {
        if (ctx.abortSignal.aborted) {
          return
        }
        const items = await ws.listVaasByEmitter(opts.fogoWormholeChainId, emitterHex, {
          pageSize: opts.pageSize,
          page,
        }).catch(() => [])
        if (items.length === 0) {
          return
        }
        for (const item of items) {
          if (ctx.abortSignal.aborted) {
            return
          }
          let resolved
          try {
            resolved = resolveNttVaa({
              vaaBytes: item.vaa,
              nttProgramId: VAA_LEG[leg].nttProgramId,
            })
          } catch {
            // Not an NTT VAA we can route — skip silently.
            continue
          }
          const flow = await ctx.client
            .fetchInflightFlow(resolved.nttInboxItem)
            .catch(() => null)
          const status = flow ? describeStatus(flow.status) : 'Pending'
          out.push({
            pubkey: resolved.nttInboxItem,
            status,
            fogoTx: item.txHash ?? '',
            vaaHex: Buffer.from(item.vaa).toString('hex'),
          })
        }
      }
    }

    if (opts.fogoUsdcEmitterHex) {
      await harvest(opts.fogoUsdcEmitterHex, 'deposit')
    }
    if (opts.fogoOnycEmitterHex) {
      await harvest(opts.fogoOnycEmitterHex, 'withdraw')
    }
    return out
  }
}
