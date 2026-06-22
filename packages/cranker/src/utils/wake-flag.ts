/**
 * Sticky one-shot wake primitive: `signal()` sets a flag and resolves any
 * pending `wait()`; `wait()` consumes it. A signal fired before `wait()` is
 * armed survives (unlike the prior EventEmitter), and multiple signals between
 * two waits coalesce to one wake. Single-consumer by design (daemon waits,
 * scanners signal).
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
