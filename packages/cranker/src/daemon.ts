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
  /** Max sleep on consecutive errors (exponential backoff cap). Default 5min. */
  maxBackoffMs?: number
  /** Max time to wait for in-flight scan to drain on abort. Default 8s. */
  shutdownDeadlineMs?: number
  /** Optional callback fired before each iteration (e.g. periodic invariant re-check). */
  preScan?: () => Promise<void>
  abortSignal: AbortSignal
  /** Optional event emitter for WebSocket wake hints — `wakeup.emit('wake')`. */
  wakeup?: EventEmitter
}

/**
 * Daemon main loop:
 *  - awaits scan; on success, stamps heartbeat + resets backoff
 *  - on failure, exponential backoff up to `maxBackoffMs`; logs (no throw)
 *  - sleeps min(currentDelay, until 'wake' event) between iterations
 *  - self-kills the process when heartbeat exceeds heartbeatStaleMs
 *    (codex P1 fix: --restart unless-stopped doesn't react to /healthz=503,
 *    so the daemon must crash itself for Docker to restart it)
 *  - on abortSignal, drains the in-flight scan up to `shutdownDeadlineMs`
 *    then exits — bounded so SIGTERM-then-SIGKILL doesn't truncate cleanup
 */
export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const watchdogIntervalMs = opts.watchdogIntervalMs ?? 15_000
  const maxBackoffMs = opts.maxBackoffMs ?? 300_000
  const shutdownDeadlineMs = opts.shutdownDeadlineMs ?? 8000
  let currentDelay = opts.intervalMs
  let consecutiveErrors = 0

  const watchdog = setInterval(() => {
    if (opts.metrics.heartbeat.ageMs() > opts.heartbeatStaleMs) {
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
      if (opts.preScan) {
        try {
          await opts.preScan()
        } catch (err) {
          console.error(JSON.stringify({ level: 'fatal', msg: 'preScan failed', err: String(err) }))
          process.exit(1)
        }
      }

      const t0 = Date.now()
      const scanCtl = new AbortController()
      const linkAbort = (): void => scanCtl.abort()
      opts.abortSignal.addEventListener('abort', linkAbort, { once: true })

      let scanError = false
      try {
        // Bound the in-flight scan so a stuck RPC can't out-wait Docker's
        // SIGTERM grace window. On outer abort, race the scan against a
        // deadline; if the deadline wins, we abandon the scan.
        if (opts.abortSignal.aborted) {
          break
        }
        await Promise.race([
          opts.scan(scanCtl.signal),
          new Promise<void>((resolve) => {
            opts.abortSignal.addEventListener('abort', () => {
              setTimeout(resolve, shutdownDeadlineMs).unref()
            }, { once: true })
          }),
        ])
        opts.metrics.heartbeat.setNow()
        opts.metrics.scanIterations.inc({ result: 'ok' })
        consecutiveErrors = 0
        currentDelay = opts.intervalMs
      } catch (err) {
        scanError = true
        opts.metrics.scanIterations.inc({ result: 'error' })

        console.error(JSON.stringify({ level: 'error', msg: 'scan failed', err: String(err) }))
      } finally {
        opts.abortSignal.removeEventListener('abort', linkAbort)
        opts.metrics.scanDuration.observe((Date.now() - t0) / 1000)
      }

      if (scanError) {
        consecutiveErrors++
        // Exponential backoff: intervalMs * 2^errors, capped.
        currentDelay = Math.min(opts.intervalMs * 2 ** consecutiveErrors, maxBackoffMs)
      }

      if (opts.abortSignal.aborted) {
        break
      }

      // Sleep for currentDelay, OR until 'wake' fires, OR until aborted.
      await Promise.race([
        new Promise<void>(r => setTimeout(r, currentDelay).unref()),
        opts.wakeup ? once(opts.wakeup, 'wake').then(() => undefined) : new Promise<never>(() => {}),
        new Promise<void>((resolve) => {
          opts.abortSignal.addEventListener('abort', () => resolve(), { once: true })
        }),
      ])
    }
  } finally {
    clearInterval(watchdog)
  }
}
