import type { WakeFlag } from './utils/wake-flag'
import { errorFields, writeLogLine } from './utils/log'

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
  /**
   * Optional wake-up channel for "chain busy → run next iteration sooner
   * than the floor". Scanners call `wakeup.signal()` when they make
   * progress; the daemon's sleep races against `wakeup.wait()`.
   *
   * Uses `WakeFlag` (not `EventEmitter`) so signals fired *during* the
   * scan are not dropped on the floor — the flag is sticky until the
   * daemon consumes it via `wait()`.
   */
  wakeup?: WakeFlag
}

/**
 * Daemon main loop:
 *  - awaits scan; on success, stamps heartbeat + resets backoff
 *  - on failure, exponential backoff up to `maxBackoffMs`; logs (no throw)
 *  - sleeps min(currentDelay, until 'wake' event) between iterations
 *  - self-kills the process when heartbeat exceeds heartbeatStaleMs
 *    (--restart unless-stopped doesn't react to /healthz=503, so the
 *    daemon must crash itself for Docker to restart it)
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
    const ageMs = opts.metrics.heartbeat.ageMs()
    if (ageMs > opts.heartbeatStaleMs) {
      writeLogLine('fatal', 'heartbeat stale — self-killing for restart', { ageMs })
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
          writeLogLine('fatal', 'preScan failed', errorFields(err))
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
          waitForShutdownDeadline(opts.abortSignal, shutdownDeadlineMs),
        ])
        opts.metrics.heartbeat.setNow()
        opts.metrics.scanIterations.inc({ result: 'ok' })
        consecutiveErrors = 0
        currentDelay = opts.intervalMs
      } catch (err) {
        // An abort during scan races to the inner Promise.race; the loser
        // throws "scan aborted mid-flight". That's the planned shutdown
        // path, not a failure — log at info, don't trip backoff.
        if (opts.abortSignal.aborted) {
          writeLogLine('info', 'scan interrupted by shutdown', errorFields(err))
        } else {
          scanError = true
          opts.metrics.scanIterations.inc({ result: 'error' })
          writeLogLine('error', 'scan failed', errorFields(err))
        }
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

      // ±10% jitter on the sleep so multiple cranker instances don't
      // synchronize their Wormholescan calls (herd → rate limits → retry
      // storms). Cheap to add and harmless when there's only one instance.
      const sleepMs = jitter(currentDelay)
      await Promise.race([
        sleep(sleepMs),
        opts.wakeup ? opts.wakeup.wait() : new Promise<never>(() => {}),
        waitForAbort(opts.abortSignal),
      ])
    }
  } finally {
    clearInterval(watchdog)
  }
}

function jitter(ms: number, factor = 0.1): number {
  const delta = ms * factor
  return Math.max(0, ms - delta + Math.random() * 2 * delta)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function waitForShutdownDeadline(signal: AbortSignal, deadlineMs: number): Promise<void> {
  if (signal.aborted) {
    return sleep(deadlineMs)
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => {
      setTimeout(resolve, deadlineMs).unref()
    }, { once: true })
  })
}
