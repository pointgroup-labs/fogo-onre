import { describe, expect, it } from 'vitest'
import { isLostRace } from '../../src/relayer/race-classifier'

describe('isLostRace', () => {
  it('returns reason for Anchor 6026 with `code` shape', () => {
    const reason = isLostRace({ code: 6026, message: 'whatever' })
    expect(reason).toMatch(/InsufficientInboxBalance/)
    expect(reason).toMatch(/6026/)
  })

  it('returns reason for Anchor 6026 with nested `error.errorCode.number` shape', () => {
    const reason = isLostRace({
      error: { errorCode: { number: 6026 } },
    })
    expect(reason).toMatch(/InsufficientInboxBalance/)
  })

  it('returns null for unknown error codes', () => {
    expect(isLostRace({ code: 6000 })).toBe(null)
    expect(isLostRace({ code: 9999 })).toBe(null)
    expect(isLostRace({ error: { errorCode: { number: 1 } } })).toBe(null)
  })

  it('returns null for non-Anchor errors (no code at all)', () => {
    expect(isLostRace(new Error('rpc timeout'))).toBe(null)
    expect(isLostRace('string error')).toBe(null)
    expect(isLostRace(null)).toBe(null)
    expect(isLostRace(undefined)).toBe(null)
    expect(isLostRace({})).toBe(null)
  })

  it('ignores non-numeric `code` values', () => {
    expect(isLostRace({ code: '6026' })).toBe(null)
    expect(isLostRace({ code: { number: 6026 } })).toBe(null)
  })
})
