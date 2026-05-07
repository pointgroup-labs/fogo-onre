import { NTT_USDC_PROGRAM_ID, USDC_MINT } from '@fogo-onre/sdk'
import { resolveNttVaa } from '../vaa'
import { PublicKey } from '@solana/web3.js'
import { describeStatus, fetchVaaBytes } from './helpers'
import type { AdvanceContext, AdvanceResult } from './types'

export type SwapUsdcToOnycInput = {
  fogoTx: string
  vaaHex?: string
  usdcMint?: PublicKey
  onycMint?: PublicKey
  nttProgram?: PublicKey
}

/**
 * Step 2: OnRe `take_offer` CPI swaps USDC → ONyc into the relayer's ONyc
 * ATA. Advances Flow Claimed → Swapped. Ported from CLI:320-399.
 */
export async function swapUsdcToOnyc(
  ctx: AdvanceContext,
  input: SwapUsdcToOnycInput,
): Promise<AdvanceResult> {
  const { client, metrics } = ctx
  const usdcMint = input.usdcMint ?? USDC_MINT
  const nttProgram = input.nttProgram ?? NTT_USDC_PROGRAM_ID

  try {
    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

    const flow = await client.fetchInflightFlow(resolved.nttInboxItem).catch(() => null)
    if (!flow) {
      return {
        kind: 'noop',
        reason: `no Flow for inbox-item ${resolved.nttInboxItem.toBase58()} — claim_usdc hasn't run`,
      }
    }
    const flowStatus = describeStatus(flow.status)
    if (flowStatus !== 'Claimed') {
      return {
        kind: 'noop',
        reason: `Flow status is ${flowStatus}, expected Claimed (already past this leg or in unexpected state)`,
      }
    }

    const cfg = await client.fetchConfig()
    const onycMint = input.onycMint ?? (cfg.onycMint as PublicKey)
    const feeVault = cfg.feeVault as PublicKey

    const sig = await client
      .swapUsdcToOnyc({
        usdcMint,
        onycMint,
        nttInboxItem: resolved.nttInboxItem,
        feeVault,
        onre: {},
      })
      .rpc()

    metrics.txSent.inc({ instruction: 'swap_usdc_to_onyc', result: 'ok' })
    metrics.flowAdvance.inc({ leg: 'deposit', from_status: 'Claimed', to_status: 'Swapped' })

    return {
      kind: 'advanced',
      signatures: [sig],
      fromStatus: 'Claimed',
      toStatus: 'Swapped',
    }
  }
  catch (err) {
    metrics.txSent.inc({ instruction: 'swap_usdc_to_onyc', result: 'error' })
    return {
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      partialSignatures: [],
    }
  }
}
