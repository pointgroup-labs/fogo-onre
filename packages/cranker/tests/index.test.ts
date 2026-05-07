import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keypair } from '@solana/web3.js'
import { afterEach, describe, expect, it } from 'vitest'
import { assertCrankerNotAuthority, installShutdownHandlers } from '../src/index'

describe('assertCrankerNotAuthority', () => {
  it('passes when keys differ', () => {
    const a = Keypair.generate().publicKey
    const b = Keypair.generate().publicKey
    expect(() => assertCrankerNotAuthority(a, b)).not.toThrow()
  })

  it('throws when keys are equal', () => {
    const k = Keypair.generate().publicKey
    expect(() => assertCrankerNotAuthority(k, k)).toThrow(/refusing to start/)
  })
})

describe('installShutdownHandlers', () => {
  afterEach(() => {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
  })

  it('aborts controller on SIGTERM', () => {
    const ctrl = new AbortController()
    installShutdownHandlers(ctrl)
    expect(ctrl.signal.aborted).toBe(false)
    process.emit('SIGTERM')
    expect(ctrl.signal.aborted).toBe(true)
  })

  it('aborts controller on SIGINT', () => {
    const ctrl = new AbortController()
    installShutdownHandlers(ctrl)
    process.emit('SIGINT')
    expect(ctrl.signal.aborted).toBe(true)
  })
})

describe('main() invariant ordering (structural)', () => {
  // Reading the source as text is unusual but proportionate: the failure
  // we're guarding against is "someone refactored main() and accidentally
  // moved assertCrankerNotAuthority below runDaemon". Mocking the entire
  // dependency graph to drive a real main() invocation costs ~200 lines
  // of test setup for one ordering check; this costs ~20.
  const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8')

  it('calls assertCrankerNotAuthority before runDaemon', () => {
    const assertIdx = src.indexOf('assertCrankerNotAuthority(relayerConfig.authority')
    const runIdx = src.indexOf('await runDaemon(')
    expect(assertIdx).toBeGreaterThan(-1)
    expect(runIdx).toBeGreaterThan(-1)
    expect(assertIdx).toBeLessThan(runIdx)
  })

  it('re-checks the invariant inside preScan', () => {
    // The first assert is at boot; the second guards against authority
    // rotation that happens while the daemon is running. Both must be
    // present in main().
    const matches = src.match(/assertCrankerNotAuthority\(/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(2)
    expect(src).toMatch(/preScan[\s\S]*assertCrankerNotAuthority/)
  })

  it('binds metrics server before any async dependency that could fail slow', () => {
    // Healthz must answer 503 during cold-start RPC fetches so Docker's
    // healthcheck has a target. metrics.start() must precede fetchConfig().
    const startIdx = src.indexOf('await metrics.start()')
    const fetchIdx = src.indexOf('await client.fetchConfig()')
    expect(startIdx).toBeGreaterThan(-1)
    expect(fetchIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeLessThan(fetchIdx)
  })
})
