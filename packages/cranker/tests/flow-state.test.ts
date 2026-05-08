import { describe, expect, it } from 'vitest'
import { FlowStateTracker } from '../src/state/flow-state'

const F = 'flow-1'

describe('flowStateTracker', () => {
  it('allows a fresh flow and flips it to inFlight', () => {
    const t = new FlowStateTracker()
    expect(t.beginIfReady(F).allowed).toBe(true)
    expect(t.inspect(F)?.kind).toBe('inFlight')
  })

  it('blocks a second begin while in flight', () => {
    const t = new FlowStateTracker()
    t.beginIfReady(F, 1000)
    const second = t.beginIfReady(F, 1500)
    expect(second.allowed).toBe(false)
    expect(second.reason).toBe('inFlight')
  })

  it('recordSuccess returns the flow to idle (absent)', () => {
    const t = new FlowStateTracker()
    t.beginIfReady(F)
    t.recordSuccess(F)
    expect(t.inspect(F)).toBeUndefined()
    expect(t.beginIfReady(F).allowed).toBe(true)
  })

  it('recordError installs an exponential cooldown', () => {
    const t = new FlowStateTracker({ cooldownBaseMs: 1000, cooldownMaxMs: 60_000 })
    t.beginIfReady(F, 0)
    const s1 = t.recordError(F, 'classA', 0)
    expect(s1.kind).toBe('cooldown')
    if (s1.kind === 'cooldown') {
      expect(s1.until).toBe(1000)
      expect(s1.attempts).toBe(1)
    }
    // Strictly inside the cooldown window: blocked.
    expect(t.beginIfReady(F, 999).allowed).toBe(false)
    expect(t.beginIfReady(F, 500).allowed).toBe(false)
    // At-or-past `until`: allowed (and `attempts` carries through).
    const after = t.beginIfReady(F, 9999)
    expect(after.allowed).toBe(true)
    const s2 = t.recordError(F, 'classA', 9999)
    if (s2.kind === 'cooldown') {
      expect(s2.attempts).toBe(2)
      expect(s2.until - 9999).toBe(2000)
    }
  })

  it('caps cooldown at cooldownMaxMs', () => {
    const t = new FlowStateTracker({ cooldownBaseMs: 1000, cooldownMaxMs: 5000, poisonThreshold: 100 })
    let now = 0
    for (let i = 0; i < 10; i++) {
      const decision = t.beginIfReady(F, now)
      if (!decision.allowed) {
        // skip ahead past the cooldown
        const cur = t.inspect(F)
        if (cur?.kind === 'cooldown') {
          now = cur.until + 1
          t.beginIfReady(F, now)
        }
      }
      t.recordError(F, 'c', now)
    }
    const final = t.inspect(F)
    if (final?.kind === 'cooldown') {
      expect(final.until - now).toBeLessThanOrEqual(5000)
    }
  })

  it('quarantines as poisoned at threshold and stays poisoned', () => {
    const t = new FlowStateTracker({ cooldownBaseMs: 1, cooldownMaxMs: 1, poisonThreshold: 3 })
    let now = 0
    for (let i = 0; i < 3; i++) {
      const d = t.beginIfReady(F, now)
      if (!d.allowed) {
        now += 10
        t.beginIfReady(F, now)
      }
      t.recordError(F, 'classA', now)
      now += 10
    }
    const final = t.inspect(F)
    expect(final?.kind).toBe('poisoned')
    if (final?.kind === 'poisoned') {
      expect(final.attempts).toBeGreaterThanOrEqual(3)
      expect(final.lastErrorClass).toBe('classA')
    }
    // Subsequent begin blocked permanently (until process restart).
    expect(t.beginIfReady(F, now + 10_000_000).allowed).toBe(false)
    expect(t.beginIfReady(F, now + 10_000_000).reason).toBe('poisoned')
  })

  it('treats a stale inFlight (timeout exceeded) as recoverable', () => {
    const t = new FlowStateTracker({ inFlightTimeoutMs: 1000 })
    t.beginIfReady(F, 0)
    expect(t.beginIfReady(F, 500).allowed).toBe(false)
    expect(t.beginIfReady(F, 5000).allowed).toBe(true)
  })

  it('evicts oldest entries when maxEntries exceeded', () => {
    const t = new FlowStateTracker({ maxEntries: 3 })
    t.beginIfReady('a')
    t.beginIfReady('b')
    t.beginIfReady('c')
    t.beginIfReady('d')
    expect(t.size()).toBe(3)
    expect(t.inspect('a')).toBeUndefined() // evicted
    expect(t.inspect('d')?.kind).toBe('inFlight')
  })
})
