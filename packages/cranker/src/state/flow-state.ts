/**
 * Per-flow ephemeral processing FSM. Distinct from on-chain Flow status
 * (which is the source of truth and lives in the Flow PDA) — this
 * tracks *what the cranker is currently doing about* a flow:
 *
 *      ┌──────┐  beginIfReady   ┌──────────┐
 *      │ idle │ ───────────────►│ inFlight │
 *      └──────┘                 └──────────┘
 *         ▲                          │
 *         │recordSuccess             │recordError
 *         │                          ▼
 *         │                    ┌──────────┐
 *         └────(when due)──────│ cooldown │
 *                              └──────────┘
 *                                    │ attempts >= POISON_THRESHOLD
 *                                    ▼
 *                              ┌──────────┐
 *                              │ poisoned │ (skipped until process restart)
 *                              └──────────┘
 *
 * Why this matters: today, a flow whose tx is still in the mempool can
 * be re-dispatched on the next 30s tick (wasted RPC + sim). And a flow
 * that has failed 50 times in a row still pays full RPC cost every
 * tick. The class-keyed log dedup quiets the noise but doesn't reduce
 * the work.
 *
 * `poisoned` is intentionally non-rotating: an operator restart is the
 * escape hatch. That's deliberate — auto-recovery from "this flow has
 * failed for 2 hours straight" without human eyes is more dangerous
 * than retrying forever once. The next tick after restart will retry.
 *
 * `inFlight` has a fallback timeout (`IN_FLIGHT_TIMEOUT_MS`) so a
 * dropped Promise (shouldn't happen given AdvanceResult contract, but
 * defensive) doesn't permanently block a flow.
 */
import { BoundedMap } from '../utils/bounded-map'

export type FlowProcState
  = | { kind: 'inFlight', startedAt: number, attempts: number }
    | { kind: 'cooldown', until: number, attempts: number }
    | { kind: 'poisoned', firstSeenAt: number, attempts: number, lastErrorClass: string }

const COOLDOWN_BASE_MS = 30_000
const COOLDOWN_MAX_MS = 60 * 60_000 // 1 hour
const POISON_THRESHOLD = 8 // ~2 hours of escalating retries before quarantine
const IN_FLIGHT_TIMEOUT_MS = 5 * 60_000 // 5 minutes — far longer than any single advance

export interface FlowStateTrackerOptions {
  cooldownBaseMs?: number
  cooldownMaxMs?: number
  poisonThreshold?: number
  inFlightTimeoutMs?: number
  /** Bound the map; oldest entries evicted FIFO. Defaults to 10k. */
  maxEntries?: number
}

export class FlowStateTracker {
  private readonly states: BoundedMap<string, FlowProcState>
  private readonly opts: Required<FlowStateTrackerOptions>

  constructor(opts: FlowStateTrackerOptions = {}) {
    this.opts = {
      cooldownBaseMs: opts.cooldownBaseMs ?? COOLDOWN_BASE_MS,
      cooldownMaxMs: opts.cooldownMaxMs ?? COOLDOWN_MAX_MS,
      poisonThreshold: opts.poisonThreshold ?? POISON_THRESHOLD,
      inFlightTimeoutMs: opts.inFlightTimeoutMs ?? IN_FLIGHT_TIMEOUT_MS,
      maxEntries: opts.maxEntries ?? 10_000,
    }
    this.states = new BoundedMap(this.opts.maxEntries)
  }

  /**
   * Try to take the dispatch slot for `flow`. Returns true if the caller
   * should proceed (and the flow is now `inFlight`); false if the flow
   * is already in flight, cooling down, or poisoned. Idempotency is on
   * the caller — repeated `beginIfReady` followed by `recordSuccess` is
   * the contract.
   */
  beginIfReady(flow: string, now = Date.now()): { allowed: boolean, reason?: string } {
    const cur = this.states.get(flow)
    let priorAttempts = 0
    if (cur) {
      if (cur.kind === 'inFlight') {
        if (now - cur.startedAt < this.opts.inFlightTimeoutMs) {
          return { allowed: false, reason: 'inFlight' }
        }
        // Stale in-flight: caller never called record*. Treat as recoverable
        // and carry the attempt count forward — a stuck dispatch shouldn't
        // wipe the cooldown history.
        priorAttempts = cur.attempts
      } else if (cur.kind === 'cooldown') {
        if (now < cur.until) {
          return { allowed: false, reason: 'cooldown' }
        }
        priorAttempts = cur.attempts
      } else if (cur.kind === 'poisoned') {
        return { allowed: false, reason: 'poisoned' }
      }
    }
    this.states.set(flow, { kind: 'inFlight', startedAt: now, attempts: priorAttempts })
    return { allowed: true }
  }

  recordSuccess(flow: string): void {
    this.states.delete(flow) // back to idle = absent (attempts reset)
  }

  recordError(flow: string, errorClass: string, now = Date.now()): FlowProcState {
    const prev = this.states.get(flow)
    // `attempts` lives on every kind now, so `recordError` after both the
    // initial inFlight and the post-cooldown inFlight retry accumulates.
    const prevAttempts = prev?.attempts ?? 0
    const attempts = prevAttempts + 1

    if (attempts >= this.opts.poisonThreshold) {
      const firstSeenAt = prev?.kind === 'poisoned' ? prev.firstSeenAt : now
      const next: FlowProcState = {
        kind: 'poisoned',
        firstSeenAt,
        attempts,
        lastErrorClass: errorClass,
      }
      this.states.set(flow, next)
      return next
    }

    // Exponential backoff with cap: 30s, 1m, 2m, 4m, 8m, 16m, 32m, …
    const backoff = Math.min(
      this.opts.cooldownBaseMs * 2 ** (attempts - 1),
      this.opts.cooldownMaxMs,
    )
    const next: FlowProcState = { kind: 'cooldown', until: now + backoff, attempts }
    this.states.set(flow, next)
    return next
  }

  inspect(flow: string): FlowProcState | undefined {
    return this.states.get(flow)
  }

  /**
   * Observability snapshot for the stuck-flow metric. `poisoned` is the
   * alertable signal — a flow that failed past the retry threshold,
   * which in practice means a persistent upstream wedge (OnRe vector
   * deletion, NTT manager pause). `cooldown` is the self-healing
   * gradient below it.
   */
  stuckCounts(): { poisoned: number, cooldown: number } {
    let poisoned = 0
    let cooldown = 0
    for (const s of this.states.values()) {
      if (s.kind === 'poisoned') {
        poisoned++
      } else if (s.kind === 'cooldown') {
        cooldown++
      }
    }
    return { poisoned, cooldown }
  }

  /** Test/observability hook. */
  size(): number {
    return this.states.size
  }
}
