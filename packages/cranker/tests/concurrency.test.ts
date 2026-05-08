import { describe, expect, it } from 'vitest'
import { runBounded } from '../src/utils/concurrency'

describe('runBounded', () => {
  it('processes every item exactly once', async () => {
    const seen = new Set<number>()
    const items = Array.from({ length: 20 }, (_, i) => i)
    await runBounded(items, 4, new AbortController().signal, async (n) => {
      seen.add(n)
    })
    expect(seen.size).toBe(20)
  })

  it('respects the concurrency bound', async () => {
    let inflight = 0
    let max = 0
    const items = Array.from({ length: 16 }, (_, i) => i)
    await runBounded(items, 3, new AbortController().signal, async () => {
      inflight++
      max = Math.max(max, inflight)
      await new Promise(r => setTimeout(r, 5))
      inflight--
    })
    expect(max).toBeLessThanOrEqual(3)
  })

  it('throwOnAbort=true: throws when signal fires mid-flight', async () => {
    const ac = new AbortController()
    const items = Array.from({ length: 10 }, (_, i) => i)
    await expect(
      runBounded(items, 2, ac.signal, async (n) => {
        if (n === 2) {
          ac.abort()
        }
        await new Promise(r => setTimeout(r, 5))
      }, { throwOnAbort: true }),
    ).rejects.toThrow(/aborted/)
  })

  it('throwOnAbort=false (default): exits silently on abort', async () => {
    const ac = new AbortController()
    const items = Array.from({ length: 10 }, (_, i) => i)
    await runBounded(items, 2, ac.signal, async (n) => {
      if (n === 2) {
        ac.abort()
      }
      await new Promise(r => setTimeout(r, 5))
    })
    // No throw; the test passing IS the assertion.
  })

  it('routes worker throws through onWorkerThrow without halting the pool', async () => {
    const errors: unknown[] = []
    const completed: number[] = []
    const items = [0, 1, 2, 3, 4]
    await runBounded(items, 2, new AbortController().signal, async (n) => {
      if (n % 2 === 0) {
        throw new Error(`worker contract violation ${n}`)
      }
      completed.push(n)
    }, { onWorkerThrow: err => errors.push(err) })
    expect(errors).toHaveLength(3) // 0, 2, 4
    expect(completed.sort()).toEqual([1, 3])
  })

  it('clamps concurrency at 1 when given 0', async () => {
    const seen: number[] = []
    await runBounded([0, 1, 2], 0, new AbortController().signal, async (n) => {
      seen.push(n)
    })
    expect(seen).toEqual([0, 1, 2])
  })
})
