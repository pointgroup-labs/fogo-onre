import { describe, expect, it } from 'vitest'
import { WakeFlag } from '../src/utils/wake-flag'

describe('wake-flag', () => {
  it('wait() resolves immediately if signal() was called first', async () => {
    const w = new WakeFlag()
    w.signal()
    // No await between signal and wait — the flag must be sticky.
    await expect(w.wait()).resolves.toBeUndefined()
  })

  it('wait() blocks until signal() is called', async () => {
    const w = new WakeFlag()
    let resolved = false
    const p = w.wait().then(() => {
      resolved = true
    })
    // Yield once; without signal(), p must not resolve.
    await new Promise(r => setTimeout(r, 5))
    expect(resolved).toBe(false)
    w.signal()
    await p
    expect(resolved).toBe(true)
  })

  it('wait() consumes the flag — second wait blocks again', async () => {
    const w = new WakeFlag()
    w.signal()
    await w.wait() // consumes
    let resolved = false
    const p = w.wait().then(() => {
      resolved = true
    })
    await new Promise(r => setTimeout(r, 5))
    expect(resolved).toBe(false)
    w.signal()
    await p
  })

  it('multiple signal()s between waits coalesce to one wake', async () => {
    const w = new WakeFlag()
    w.signal()
    w.signal()
    w.signal()
    await w.wait() // consumes the single sticky flag
    let resolved = false
    const p = w.wait().then(() => {
      resolved = true
    })
    await new Promise(r => setTimeout(r, 5))
    // No outstanding signal — second wait must block.
    expect(resolved).toBe(false)
    w.signal()
    await p
  })

  it('signal() during a pending wait() resolves it', async () => {
    const w = new WakeFlag()
    const p = w.wait()
    // Microtask gap to confirm wait() is genuinely pending.
    await Promise.resolve()
    w.signal()
    await expect(p).resolves.toBeUndefined()
  })

  it('races with a sleep — wake wins when signaled early', async () => {
    // The bug fix scenario: a signal() emitted *before* the daemon
    // calls wait() must still cause the race to resolve immediately.
    const w = new WakeFlag()
    w.signal()
    const sleepMs = 100
    const t0 = Date.now()
    await Promise.race([
      w.wait(),
      new Promise(r => setTimeout(r, sleepMs)),
    ])
    const elapsed = Date.now() - t0
    expect(elapsed).toBeLessThan(sleepMs / 2) // resolved well before sleep
  })
})
