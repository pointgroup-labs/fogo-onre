import type { AdvanceContext } from '../src/relayer/types'
import type { WormholescanVaa } from '../src/wormholescan'
import { NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID, ONYC_MINT, USDC_MINT } from '@fogo-onre/sdk'
import { describe, expect, it, vi } from 'vitest'
import { makeEnumerator } from '../src/relayer/enumerate'
import { silentLogger } from '../src/utils/log'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function makeFetchImpl(handler: (url: string) => unknown): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => jsonResponse(handler(String(input)))) as typeof fetch
}

function makeCtx(abortSignal = new AbortController().signal): AdvanceContext {
  return {
    abortSignal,
    client: {
      fetchInflightFlow: async () => null,
      fetchConfig: async () => ({
        nttBaseProgram: NTT_USDC_PROGRAM_ID,
        nttAssetProgram: NTT_ONYC_PROGRAM_ID,
        baseMint: USDC_MINT,
        assetMint: ONYC_MINT,
      }),
    },
    connection: undefined as never,
    fogoConnection: undefined as never,
    provider: undefined as never,
    keypair: undefined as never,
    relayerProgramId: undefined as never,
    wormholescanUrl: '',
    wormholescanTimeoutMs: 0,
    metrics: undefined as never,
    log: silentLogger(),
  }
}

describe('makeEnumerator', () => {
  it('returns empty when no emitters configured', async () => {
    const fetchImpl = vi.fn()
    const enumerate = makeEnumerator({
      fogoWormholeChainId: 28,
      pageSize: 50,
      maxPages: 1,
      baseUrl: 'https://wh.test',
      fetchImpl,
    })
    const flows = await enumerate(makeCtx())
    expect(flows).toHaveLength(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('respects abort during pagination', async () => {
    const fetchImpl = makeFetchImpl(() => ({ data: [] }))
    const ac = new AbortController()
    const enumerate = makeEnumerator({
      fogoWormholeChainId: 28,
      fogoUsdcEmitterHex: 'a'.repeat(64),
      pageSize: 50,
      maxPages: 5,
      baseUrl: 'https://wh.test',
      fetchImpl,
    })
    ac.abort()
    const flows = await enumerate(makeCtx(ac.signal))
    expect(flows).toHaveLength(0)
  })

  it('skips VAAs that fail to parse', async () => {
    const badVaa: WormholescanVaa = {
      vaa: Uint8Array.from(Buffer.from('not-a-vaa')),
      sequence: 1n,
      txHash: 'tx1',
    }
    const fetchImpl = makeFetchImpl((url) => {
      if (url.includes('vaas/28')) {
        return {
          data: [{
            vaa: Buffer.from(badVaa.vaa).toString('base64'),
            sequence: badVaa.sequence.toString(),
            txHash: badVaa.txHash,
          }],
        }
      }
      return { data: [] }
    })
    const enumerate = makeEnumerator({
      fogoWormholeChainId: 28,
      fogoUsdcEmitterHex: 'a'.repeat(64),
      pageSize: 50,
      maxPages: 1,
      baseUrl: 'https://wh.test',
      fetchImpl,
    })
    const flows = await enumerate(makeCtx())
    expect(flows).toHaveLength(0)
  })
})
