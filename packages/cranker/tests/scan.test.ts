import type { AdvanceContext } from '../src/advance/types'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { scanAndAdvance } from '../src/scan'

// Minimal mock context — scanAndAdvance only reads abortSignal directly;
// the rest is forwarded to advance fns which we mock entirely.
function makeCtx(abortSignal = new AbortController().signal): AdvanceContext {
  return {
    abortSignal,
  } as unknown as AdvanceContext
}

const PUBKEY = new PublicKey('11111111111111111111111111111111')

describe('scanAndAdvance', () => {
  it('dispatches claimUsdc for Pending flows and skips terminal/unknown', async () => {
    const claimUsdc = vi.fn().mockResolvedValue({ kind: 'noop', reason: 'test' })
    const swapUsdcToOnyc = vi.fn().mockResolvedValue({ kind: 'noop', reason: 'test' })
    const lockOnyc = vi.fn().mockResolvedValue({ kind: 'noop', reason: 'test' })

    await scanAndAdvance(makeCtx(), {
      maxConcurrentAdvances: 4,
      rpcTimeoutMs: 5000,
      enumerateFlows: async () => [
        { pubkey: PUBKEY, status: 'Pending', fogoTx: 'tx-A' },
        { pubkey: PUBKEY, status: 'Closed', fogoTx: 'tx-B' }, // terminal — skipped
        { pubkey: PUBKEY, status: 'Swapped', fogoTx: 'tx-C' },
      ],
      advanceFns: {
        claimUsdc,
        swapUsdcToOnyc,
        lockOnyc,
        unlockOnyc: vi.fn(),
        requestRedemption: vi.fn(),
        claimRedemption: vi.fn(),
        sendUsdcToUser: vi.fn(),
      },
    })

    expect(claimUsdc).toHaveBeenCalledTimes(1)
    expect(lockOnyc).toHaveBeenCalledTimes(1)
    expect(swapUsdcToOnyc).toHaveBeenCalledTimes(0)
  })

  it('respects maxConcurrentAdvances bound', async () => {
    let inflight = 0
    let maxObserved = 0
    const claimUsdc = vi.fn().mockImplementation(async () => {
      inflight++
      maxObserved = Math.max(maxObserved, inflight)
      await new Promise(r => setTimeout(r, 20))
      inflight--
      return { kind: 'noop', reason: 'test' }
    })

    const flows = Array.from({ length: 10 }, (_, i) => ({
      pubkey: PUBKEY,
      status: 'Pending',
      fogoTx: `tx-${i}`,
    }))

    await scanAndAdvance(makeCtx(), {
      maxConcurrentAdvances: 2,
      rpcTimeoutMs: 5000,
      enumerateFlows: async () => flows,
      advanceFns: {
        claimUsdc,
        swapUsdcToOnyc: vi.fn(),
        lockOnyc: vi.fn(),
        unlockOnyc: vi.fn(),
        requestRedemption: vi.fn(),
        claimRedemption: vi.fn(),
        sendUsdcToUser: vi.fn(),
      },
    })

    expect(claimUsdc).toHaveBeenCalledTimes(10)
    expect(maxObserved).toBeLessThanOrEqual(2)
  })

  it('honors abortSignal aborted before start', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(
      scanAndAdvance(makeCtx(ac.signal), {
        maxConcurrentAdvances: 2,
        rpcTimeoutMs: 5000,
        enumerateFlows: async () => [{ pubkey: PUBKEY, status: 'Pending', fogoTx: 'tx-A' }],
        advanceFns: {
          claimUsdc: vi.fn(),
          swapUsdcToOnyc: vi.fn(),
          lockOnyc: vi.fn(),
          unlockOnyc: vi.fn(),
          requestRedemption: vi.fn(),
          claimRedemption: vi.fn(),
          sendUsdcToUser: vi.fn(),
        },
      }),
    ).rejects.toThrow(/abort/)
  })
})
