import type { WormholescanVaa } from '@fogo-onre/sdk'
import type { WatermarkStore } from '../src/state/watermarks'
import { describe, expect, it } from 'vitest'
import { watermarkKey } from '../src/state/watermarks'
import { harvestVaaPages } from '../src/utils/wormholescan-pages'

const E = 'aa'.repeat(32)

// Minimal stub of WormholescanClient that returns canned page contents.
function fakeWs(pages: WormholescanVaa[][]): {
  listVaasByEmitter: (chain: number, emitter: string, args: { pageSize: number, page: number }) => Promise<WormholescanVaa[]>
} {
  return {
    listVaasByEmitter: async (_chain, _emitter, args) => pages[args.page] ?? [],
  }
}

function vaa(seq: bigint): WormholescanVaa {
  return {
    sequence: seq,
    vaa: new Uint8Array([1, 2, 3]),
    txHash: `tx-${seq}`,
  } as WormholescanVaa
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) {
    out.push(v)
  }
  return out
}

describe('harvestVaaPages', () => {
  it('yields each page in order until empty', async () => {
    const ws = fakeWs([[vaa(10n), vaa(9n)], [vaa(8n)], []]) as never
    const pages = await collect(harvestVaaPages({
      ws,
      chainId: 1,
      emitterHex: E,
      pageSize: 50,
      maxPages: 5,
      abortSignal: new AbortController().signal,
    }))
    expect(pages.map(p => p.length)).toEqual([2, 1])
  })

  it('stops at maxPages even when more pages are available', async () => {
    const ws = fakeWs([[vaa(3n)], [vaa(2n)], [vaa(1n)]]) as never
    const pages = await collect(harvestVaaPages({
      ws,
      chainId: 1,
      emitterHex: E,
      pageSize: 50,
      maxPages: 2,
      abortSignal: new AbortController().signal,
    }))
    expect(pages).toHaveLength(2)
  })

  it('does NOT record watermarks itself (consumer is responsible)', async () => {
    // Watermark advancement moved out of the harvest into the consumer
    // (enumerate.ts / bridge/scan.ts) so a transient per-VAA fetch
    // failure can't advance the floor past an unprocessed VAA.
    const watermarks: WatermarkStore = new Map()
    const ws = fakeWs([[vaa(5n), vaa(7n)], []]) as never
    await collect(harvestVaaPages({
      ws,
      chainId: 1,
      emitterHex: E,
      pageSize: 50,
      maxPages: 5,
      watermarks,
      abortSignal: new AbortController().signal,
    }))
    expect(watermarks.size).toBe(0)
  })

  it('stops early when an entire page is at-or-below the watermark floor', async () => {
    // Watermark at 100 → floor = 95. Page with all sequences ≤ 95 means
    // we've caught up; subsequent pages are guaranteed older still.
    const watermarks: WatermarkStore = new Map([[watermarkKey(1, E), 100n]])
    let pagesFetched = 0
    const ws = {
      listVaasByEmitter: async (_chain: number, _emitter: string, args: { page: number }) => {
        pagesFetched = args.page + 1
        if (args.page === 0) {
          return [vaa(95n), vaa(94n)] // entirely below floor
        }
        return [vaa(50n)]
      },
    } as never
    await collect(harvestVaaPages({
      ws,
      chainId: 1,
      emitterHex: E,
      pageSize: 50,
      maxPages: 5,
      watermarks,
      abortSignal: new AbortController().signal,
    }))
    expect(pagesFetched).toBe(1)
  })

  it('honors abortSignal between pages', async () => {
    const ac = new AbortController()
    const ws = {
      listVaasByEmitter: async (_chain: number, _emitter: string, _args: { page: number }) => [vaa(10n)],
    } as never
    const pages: WormholescanVaa[][] = []
    for await (const items of harvestVaaPages({
      ws,
      chainId: 1,
      emitterHex: E,
      pageSize: 50,
      maxPages: 5,
      abortSignal: ac.signal,
    })) {
      pages.push(items)
      // Abort *between* yields — the harvest loop's pre-fetch abort
      // check on the next iteration must short-circuit.
      ac.abort()
    }
    expect(pages.map(p => p.length)).toEqual([1])
  })

  it('surfaces fetch errors via onPageError and stops on the empty result', async () => {
    const errs: Array<{ page: number, err: unknown }> = []
    const ws = {
      listVaasByEmitter: async () => {
        throw new Error('wormholescan down')
      },
    } as never
    const pages = await collect(harvestVaaPages({
      ws,
      chainId: 1,
      emitterHex: E,
      pageSize: 50,
      maxPages: 5,
      abortSignal: new AbortController().signal,
      onPageError: (page, err) => errs.push({ page, err }),
    }))
    expect(pages).toEqual([]) // empty result → harvest stops
    expect(errs).toHaveLength(1)
    expect((errs[0].err as Error).message).toBe('wormholescan down')
  })
})
