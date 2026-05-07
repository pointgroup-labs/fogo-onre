import { describe, expect, it, vi } from 'vitest'
import { runDaemon } from '../src/daemon'

function makeMockMetrics() {
  let lastHeartbeat = Date.now()
  return {
    heartbeat: {
      setNow: vi.fn(() => { lastHeartbeat = Date.now() }),
      setAt: vi.fn((t: number) => { lastHeartbeat = t }),
      ageMs: () => Date.now() - lastHeartbeat,
    },
    scanIterations: { inc: vi.fn() },
    scanDuration: { observe: vi.fn() },
  }
}

describe('runDaemon', () => {
  it('updates heartbeat after successful scan', async () => {
    const scan = vi.fn().mockResolvedValue(undefined)
    const metrics = makeMockMetrics()
    const ctrl = new AbortController()

    // Run for ~50ms then abort — long enough for one scan iteration.
    const promise = runDaemon({
      scan,
      metrics,
      intervalMs: 1_000_000, // long, so we abort before the second iteration
      heartbeatStaleMs: 120_000,
      abortSignal: ctrl.signal,
    })

    await new Promise(r => setTimeout(r, 30))
    expect(scan).toHaveBeenCalled()
    expect(metrics.heartbeat.setNow).toHaveBeenCalled()

    ctrl.abort()
    await promise
  })

  it('triggers self-kill (process.exit) when heartbeat goes stale', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    let scanResolve: () => void = () => {}
    const scan = vi.fn().mockImplementation(() => new Promise<void>((r) => {
      scanResolve = r
    }))
    const metrics = makeMockMetrics()
    const ctrl = new AbortController()

    // heartbeatStaleMs=50ms, watchdogIntervalMs=20ms — fires while scan hangs.
    const promise = runDaemon({
      scan,
      metrics,
      intervalMs: 1_000_000,
      heartbeatStaleMs: 50,
      watchdogIntervalMs: 20,
      abortSignal: ctrl.signal,
    })

    // Wait long enough for at least one watchdog fire after staleness.
    await new Promise(r => setTimeout(r, 120))
    expect(exit).toHaveBeenCalledWith(1)

    // Cleanup: resolve the scan and abort so the daemon promise settles.
    scanResolve()
    ctrl.abort()
    exit.mockRestore()
    await promise.catch(() => undefined)
  })

  it('drains in-flight scan on abort before resolving', async () => {
    let scanFinished = false
    const scan = vi.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 80))
      scanFinished = true
    })
    const metrics = makeMockMetrics()
    const ctrl = new AbortController()

    const promise = runDaemon({
      scan,
      metrics,
      intervalMs: 1_000_000,
      heartbeatStaleMs: 120_000,
      abortSignal: ctrl.signal,
    })

    // Abort mid-scan (40ms in, scan resolves at 80ms).
    setTimeout(() => ctrl.abort(), 40)
    await promise

    expect(scanFinished).toBe(true) // daemon awaited scan completion before exiting
  })
})
