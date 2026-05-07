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
