/**
 * Regression guard for the post-upgrade "stale FlowStatus tag" failure
 * mode observed on 2026-05-11 against mainnet inbox-item
 * `FEjqpMcDJJpZRRFUnThF874GKVUUhx3ohnB9EepqNcBj`. The cranker scanner
 * was wedged in an infinite retry loop because every poll re-fetched the
 * same undecodable PDA and classified the Borsh decode crash as a
 * transient RPC error. `isUndecodableAccountError` distinguishes that
 * failure mode so the scanner can advance the watermark past stuck PDAs
 * rather than loop forever.
 */
import { describe, expect, it } from 'vitest'
import { isUndecodableAccountError } from '../../src/relayer/enumerate'

describe('isUndecodableAccountError', () => {
  it('matches the canonical BorshAccountsCoder TypeError stack', () => {
    const err = new TypeError('Cannot read properties of null (reading \'property\')')
    err.stack = [
      'TypeError: Cannot read properties of null (reading \'property\')',
      '    at Union.decode (file:///app/dist/bin.js:10777:20)',
      '    at Structure.decode (file:///app/dist/bin.js:10519:36)',
      '    at BorshAccountsCoder.decodeUnchecked (file:///app/dist/bin.js:24912:30)',
      '    at BorshAccountsCoder.decode (file:///app/dist/bin.js:24894:21)',
    ].join('\n')
    expect(isUndecodableAccountError(err)).toBe(true)
  })

  it('matches when only Union.decode appears in the frame', () => {
    const err = new TypeError('Cannot read properties of null (reading \'foo\')')
    err.stack = 'TypeError: ...\n    at Union.decode (somewhere)'
    expect(isUndecodableAccountError(err)).toBe(true)
  })

  it('rejects TypeErrors from unrelated call sites', () => {
    const err = new TypeError('Cannot read properties of undefined (reading \'x\')')
    err.stack = 'TypeError: ...\n    at PromiseHandler.then (somewhere)'
    expect(isUndecodableAccountError(err)).toBe(false)
  })

  it('rejects non-TypeError errors even with matching frame text', () => {
    const err = new Error('rpc unavailable')
    err.stack = 'Error: rpc unavailable\n    at BorshAccountsCoder.decode (...)'
    expect(isUndecodableAccountError(err)).toBe(false)
  })

  it('rejects non-Error inputs', () => {
    expect(isUndecodableAccountError(null)).toBe(false)
    expect(isUndecodableAccountError(undefined)).toBe(false)
    expect(isUndecodableAccountError('string error')).toBe(false)
    expect(isUndecodableAccountError({ message: 'x' })).toBe(false)
  })

  it('does not match the routine "Account does not exist" RPC error', () => {
    const err = new Error('Account does not exist or has no data abc...')
    expect(isUndecodableAccountError(err)).toBe(false)
  })
})
