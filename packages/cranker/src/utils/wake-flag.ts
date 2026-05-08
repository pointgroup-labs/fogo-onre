/**
 * One-shot wake primitive that survives signals fired before `wait()` is
 * armed. Replaces the `EventEmitter`-based daemon wake-up channel, which
 * silently dropped any `emit('wake')` that landed before the daemon's
 * `once(emitter, 'wake')` listener was attached.
 *
 * Semantics: `signal()` sets a sticky flag and resolves any pending
 * `wait()`. `wait()` consumes the flag (clears it before returning) so the
 * next `wait()` call blocks again. Multiple `signal()` calls between two
 * `wait()` calls coalesce to a single wake — the daemon doesn't care
 * how many progress events fired during a scan, only that *at least one*
 * did.
 *
 * Single-consumer by design. The daemon is the only `wait()` caller; the
 * scanners are the only `signal()` callers. If a second consumer is ever
 * needed, we'd swap to a broadcast queue, but the current shape is
 * intentionally simpler than EventEmitter.
 */
export class WakeFlag {
  private flagged = false
  private resolveCurrent?: () => void

  /** Idempotent. Sets the flag; resolves any pending wait(). */
  signal(): void {
    this.flagged = true
    const r = this.resolveCurrent
    this.resolveCurrent = undefined
    r?.()
  }

  /**
   * Resolves immediately if `signal()` was called since the last `wait()`,
   * otherwise blocks until the next `signal()`. Always consumes the flag.
   */
  wait(): Promise<void> {
    if (this.flagged) {
      this.flagged = false
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.resolveCurrent = resolve
    })
  }
}
