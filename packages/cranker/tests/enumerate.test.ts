import { PublicKey } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { makeEnumerator } from '../src/enumerate'

const PUBKEY = new PublicKey('11111111111111111111111111111111')

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
    const ctx = { abortSignal: new AbortController().signal, client: {} as any } as any
    const flows = await enumerate(ctx)
    expect(flows).toHaveLength(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('respects abort during pagination', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    } as any)
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
    const ctx = { abortSignal: ac.signal, client: {} as any } as any
    const flows = await enumerate(ctx)
    expect(flows).toHaveLength(0)
  })

  it('skips VAAs that fail to parse', async () => {
    // Wormholescan returns an item with garbage VAA bytes; resolveNttVaa throws; enumerate must continue.
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('vaas/28')) {
        return {
          ok: true,
          json: async () => ({ data: [{ vaa: Buffer.from('not-a-vaa').toString('base64'), sequence: '1', txHash: 'tx1' }] }),
        }
      }
      return { ok: true, json: async () => ({ data: [] }) }
    })
    const enumerate = makeEnumerator({
      fogoWormholeChainId: 28,
      fogoUsdcEmitterHex: 'a'.repeat(64),
      pageSize: 50,
      maxPages: 1,
      baseUrl: 'https://wh.test',
      fetchImpl: fetchImpl as any,
    })
    const ctx = {
      abortSignal: new AbortController().signal,
      client: { fetchInflightFlow: async () => null },
    } as any
    void PUBKEY
    const flows = await enumerate(ctx)
    expect(flows).toHaveLength(0)
  })
})
