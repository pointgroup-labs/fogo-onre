/**
 * OnRe NAV math now lives TS-only — it backs the client `min_out` preview
 * the cranker quotes against. The on-chain floor is the user-signed
 * `flow.min_swap_out`, not a re-derived NAV, so there is no Rust handler
 * to keep in lockstep. These tests still gate upstream `Offer` layout /
 * price-formula drift via the fixture pins below.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  calculateStepPrice,
  depositExpectedOut,
  ONRE_OFFER_ACCOUNT_SIZE,
  ONRE_OFFER_MAX_VECTORS,
  ONRE_OFFER_VECTOR_SIZE,
  ONRE_OFFER_VECTORS_OFFSET,
  parseActiveOfferVector,
  redemptionExpectedOut,
  synthOfferBuffer,
} from '@fogo-onre/sdk'
import { describe, expect, it } from 'vitest'

describe('redemptionExpectedOut', () => {
  it('identity at 1:1 price, equal decimals', () => {
    expect(redemptionExpectedOut(1_000_000n, 1_000_000_000n, 6, 6)).toBe(1_000_000n)
  })

  it('two-to-one price doubles output', () => {
    expect(redemptionExpectedOut(1_000_000n, 2_000_000_000n, 6, 6)).toBe(2_000_000n)
  })
})

describe('depositExpectedOut', () => {
  it('is the algebraic inverse of redemptionExpectedOut', () => {
    expect(depositExpectedOut(1_000_000n, 1_000_000_000n, 6, 6)).toBe(1_000_000n)
    expect(depositExpectedOut(2_000_000n, 2_000_000_000n, 6, 6)).toBe(1_000_000n)
  })

  it('matches the real OnRe binary mint (e2e-verified fixture)', () => {
    // 0.5 USDC at the mainnet offer step price the deposit e2e exercises:
    // the real OnRe `.so` minted 233_069 ONyc gross — exact to the unit.
    expect(depositExpectedOut(500_000n, 2_145_284_934n, 6, 6)).toBe(233_069n)
  })

  it('rejects a zero price', () => {
    expect(() => depositExpectedOut(1_000_000n, 0n, 6, 6)).toThrow('OnreNoActiveVector')
  })
})

describe('parseActiveOfferVector', () => {
  const v = (
    start_time: bigint,
    base_time: bigint,
    base_price: bigint,
    apr: bigint,
    price_fix_duration: bigint,
  ) => ({ start_time, base_time, base_price, apr, price_fix_duration })

  it('rejects short account', () => {
    const short = new Uint8Array(ONRE_OFFER_ACCOUNT_SIZE - 1)
    expect(() => parseActiveOfferVector(short, 0n)).toThrow(/OnreOfferTooShort/)
  })

  it('returns null when all slots zeroed', () => {
    const data = synthOfferBuffer([])
    expect(() => parseActiveOfferVector(data, 1_000_000_000n)).toThrow(/OnreNoActiveVector/)
  })

  it('skips future-only vectors', () => {
    const data = synthOfferBuffer([v(2_000n, 2_000n, 1_000_000_000n, 0n, 86_400n)])
    expect(() => parseActiveOfferVector(data, 1_999n)).toThrow(/OnreNoActiveVector/)
  })

  it('picks max start_time when multiple qualify', () => {
    const data = synthOfferBuffer([
      v(1_000n, 1_000n, 1_000_000_000n, 0n, 86_400n),
      v(2_000n, 2_000n, 2_000_000_000n, 0n, 86_400n),
      v(1_500n, 1_500n, 1_500_000_000n, 0n, 86_400n),
    ])
    const active = parseActiveOfferVector(data, 3_000n)
    expect(active.start_time).toBe(2_000n)
    expect(active.base_price).toBe(2_000_000_000n)
  })

  it('ignores zero sentinel slot in the middle', () => {
    const data = synthOfferBuffer([
      v(1_000n, 1_000n, 1_000_000_000n, 0n, 86_400n),
      v(0n, 0n, 0n, 0n, 0n),
      v(2_000n, 2_000n, 2_000_000_000n, 0n, 86_400n),
    ])
    expect(parseActiveOfferVector(data, 3_000n).start_time).toBe(2_000n)
  })

  it('layout constants match Rust pins', () => {
    expect(ONRE_OFFER_ACCOUNT_SIZE).toBe(608)
    expect(ONRE_OFFER_VECTORS_OFFSET).toBe(72)
    expect(ONRE_OFFER_VECTOR_SIZE).toBe(40)
    expect(ONRE_OFFER_MAX_VECTORS).toBe(10)
  })
})

describe('calculateStepPrice', () => {
  const v = (
    start_time: bigint,
    base_time: bigint,
    base_price: bigint,
    apr: bigint,
    price_fix_duration: bigint,
  ) => ({ start_time, base_time, base_price, apr, price_fix_duration })

  it('zero apr returns base_price', () => {
    expect(calculateStepPrice(v(1_000n, 1_000n, 1_085_708_975n, 0n, 86_400n), 1_500n))
      .toBe(1_085_708_975n)
  })

  it('snaps forward to interval end (mainnet fixture parity)', () => {
    const vec = v(1_773_878_400n, 1_773_878_400n, 1_085_708_975n, 97_593n, 86_400n)
    // Mirror of Rust expected calculation:
    // den = 1e6 * 31_536_000 = 3.1536e13
    // y_part = 97_593 * 86_400
    // expected = base_price * (den + y_part) / den
    const den = 1_000_000n * 31_536_000n
    const yPart = 97_593n * 86_400n
    const expected = (1_085_708_975n * (den + yPart)) / den
    // One second in: already snapped to step-end.
    expect(calculateStepPrice(vec, 1_773_878_401n)).toBe(expected)
    // Still inside step 0 → flat.
    expect(calculateStepPrice(vec, 1_773_878_402n)).toBe(expected)
  })

  it('rejects now < base_time', () => {
    expect(() => calculateStepPrice(v(1_000n, 1_000n, 1n, 100_000n, 86_400n), 999n))
      .toThrow(/OnreNoActiveVector/)
  })

  it('rejects zero price_fix_duration', () => {
    expect(() => calculateStepPrice(v(1_000n, 1_000n, 1n, 100_000n, 0n), 2_000n))
      .toThrow(/OnreNoActiveVector/)
  })
})

/**
 * Drift tripwire: pins the TS `Offer` parser to the canonical mainnet
 * fixture (`onre-offer.bin`). If OnRe re-lays out `Offer`, this fires so
 * the `min_out` preview is refreshed in lockstep with the fixture.
 */
describe('offer mainnet fixture parity', () => {
  it('parses the same active vector the Rust suite asserts', () => {
    const path = resolve(
      __dirname,
      '../tests/fixtures/accounts/E88zkA9Pxb1i8EfSHrEW5ZUe6hiQbo8DHWQ3WhDFw7p6.json',
    )
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      account: { data: [string, string] }
    }
    const data = Uint8Array.from(Buffer.from(raw.account.data[0], 'base64'))
    expect(data.length).toBe(ONRE_OFFER_ACCOUNT_SIZE)

    // Lock the Rust `offer_layout_matches_fixture` bin to this canonical
    // JSON: a mainnet refresh must regenerate onre-offer.bin in lockstep.
    const binPath = resolve(__dirname, '../tests/fixtures/accounts/onre-offer.bin')
    expect(Buffer.from(readFileSync(binPath))).toEqual(Buffer.from(data))

    const active = parseActiveOfferVector(data, 2_000_000_000n)
    expect(active.start_time).toBe(1_773_878_400n)
    expect(active.base_price).toBe(1_085_708_975n)
    expect(active.apr).toBe(97_593n)
    expect(active.price_fix_duration).toBe(86_400n)
  })
})
