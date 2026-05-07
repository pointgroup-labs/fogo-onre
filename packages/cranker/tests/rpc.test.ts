import { describe, expect, it, vi } from 'vitest'
import { withTimeout } from '../src/rpc'

describe('withTimeout', () => {
  it('resolves when underlying promise resolves before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test')
    expect(result).toBe(42)
  })

  it('rejects with timeout label when slower than budget', async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve('late'), 200))
    await expect(withTimeout(slow, 50, 'getSlot')).rejects.toThrow(/timeout.*getSlot/)
  })

  it('does not leak timer on resolve', async () => {
    vi.useFakeTimers()
    await withTimeout(Promise.resolve(1), 10_000, 'x')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
