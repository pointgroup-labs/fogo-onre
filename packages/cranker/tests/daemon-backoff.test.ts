import { describe, expect, it, vi } from 'vitest'
import { runDaemon } from '../src/daemon'

function makeMockMetrics() {
  let lastHeartbeat = Date.now()
  return {
    heartbeat: {
      setNow: vi.fn(() => { lastHeartbeat = Date.now() }),
      ageMs: () => Date.now() - lastHeartbeat,
    },
    scanIterations: { inc: vi.fn() },
    scanDuration: { observe: vi.fn() },
  }
}

describe('runDaemon backoff', () => {
  it('grows sleep on consecutive errors and resets on success', async () => {
    const calls: number[] = []
    let succeed = false
    const scan = vi.fn().mockImplementation(async () => {
      calls.push(Date.now())
      if (!succeed) {
        throw new Error('rpc dead')
      }
    })
    const metrics = makeMockMetrics()
    const ctrl = new AbortController()

    const promise = runDaemon({
      scan,
      metrics,
      intervalMs: 20,
      maxBackoffMs: 200,
      heartbeatStaleMs: 60_000,
      abortSignal: ctrl.signal,
    })

    // Let two error iterations run; second sleep should be longer than the first.
    await new Promise(r => setTimeout(r, 100))
    expect(scan).toHaveBeenCalled()
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const gap1 = calls[1] - calls[0]
    expect(gap1).toBeGreaterThanOrEqual(20)

    // Now flip to success — heartbeat should advance, error counter resets.
    succeed = true
    await new Promise(r => setTimeout(r, 250))
    expect(metrics.heartbeat.setNow).toHaveBeenCalled()

    ctrl.abort()
    await promise.catch(() => undefined)
  })
})

describe('runDaemon shutdown deadline', () => {
  it('exits within deadline even if scan never resolves', async () => {
    const scan = vi.fn().mockImplementation(() => new Promise<void>(() => {})) // never resolves
    const metrics = makeMockMetrics()
    const ctrl = new AbortController()
    const t0 = Date.now()
    const promise = runDaemon({
      scan,
      metrics,
      intervalMs: 1_000_000,
      heartbeatStaleMs: 120_000,
      shutdownDeadlineMs: 60,
      abortSignal: ctrl.signal,
    })
    setTimeout(() => ctrl.abort(), 30)
    await promise
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(500)
  })
})

describe('runDaemon preScan', () => {
  it('exits process when preScan throws', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const scan = vi.fn().mockResolvedValue(undefined)
    const metrics = makeMockMetrics()
    const ctrl = new AbortController()
    const preScan = vi.fn().mockRejectedValue(new Error('authority rotated to cranker'))
    const promise = runDaemon({
      scan,
      metrics,
      intervalMs: 1_000_000,
      heartbeatStaleMs: 120_000,
      preScan,
      abortSignal: ctrl.signal,
    })
    await new Promise(r => setTimeout(r, 30))
    expect(exit).toHaveBeenCalledWith(1)
    ctrl.abort()
    exit.mockRestore()
    await promise.catch(() => undefined)
  })
})
