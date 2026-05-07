import type { EventEmitter } from 'node:events'
import { once } from 'node:events'

export type DaemonHeartbeat = {
  setNow: () => void
  ageMs: () => number
}

export type DaemonMetrics = {
  heartbeat: DaemonHeartbeat
  scanIterations: { inc: (labels: { result: string }) => void }
  scanDuration: { observe: (seconds: number) => void }
}

export type DaemonOptions = {
  scan: (signal: AbortSignal) => Promise<void>
  metrics: DaemonMetrics
  intervalMs: number
  heartbeatStaleMs: number
  /** How often the self-kill watchdog checks heartbeat age. Default 15s. */
  watchdogIntervalMs?: number
  abortSignal: AbortSignal
  /** Optional event emitter for WebSocket wake hints — `wakeup.emit('wake')`. */
  wakeup?: EventEmitter
}

/**
 * Daemon main loop:
 *  - awaits scan; on success, stamps heartbeat
 *  - on failure, logs (no throw) and continues
 *  - sleeps min(intervalMs, until 'wake' event) between iterations
 *  - self-kills the process when heartbeat exceeds heartbeatStaleMs
 *    (codex P1 fix: --restart unless-stopped doesn't react to /healthz=503,
 *    so the daemon must crash itself for Docker to restart it)
 *  - on abortSignal, drains the in-flight scan then exits cleanly
 */
export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const watchdogIntervalMs = opts.watchdogIntervalMs ?? 15_000

  const watchdog = setInterval(() => {
    if (opts.metrics.heartbeat.ageMs() > opts.heartbeatStaleMs) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        level: 'fatal',
        msg: 'heartbeat stale — self-killing for restart',
        ageMs: opts.metrics.heartbeat.ageMs(),
      }))
      process.exit(1)
    }
  }, watchdogIntervalMs)
  watchdog.unref()

  try {
    while (!opts.abortSignal.aborted) {
      const t0 = Date.now()
      const scanCtl = new AbortController()
      const linkAbort = () => scanCtl.abort()
      opts.abortSignal.addEventListener('abort', linkAbort, { once: true })

      try {
        await opts.scan(scanCtl.signal)
        opts.metrics.heartbeat.setNow()
        opts.metrics.scanIterations.inc({ result: 'ok' })
      }
      catch (err) {
        opts.metrics.scanIterations.inc({ result: 'error' })
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ level: 'error', msg: 'scan failed', err: String(err) }))
      }
      finally {
        opts.abortSignal.removeEventListener('abort', linkAbort)
        opts.metrics.scanDuration.observe((Date.now() - t0) / 1000)
      }

      if (opts.abortSignal.aborted) {
        break
      }

      // Sleep for intervalMs, OR until 'wake' fires, OR until aborted.
      await Promise.race([
        new Promise<void>(r => setTimeout(r, opts.intervalMs).unref()),
        opts.wakeup ? once(opts.wakeup, 'wake').then(() => undefined) : new Promise<never>(() => {}),
        new Promise<void>((resolve) => {
          opts.abortSignal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
    }
  }
  finally {
    clearInterval(watchdog)
  }
}
