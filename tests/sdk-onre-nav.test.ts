/**
 * Drift tripwire mirror: every test in this file has a paired test in
 * `programs/relayer/src/onre.rs` (mod tests). When upstream OnRe re-lays
 * out `Offer` or changes the price formula, BOTH suites must fire — if
 * only one does, the TS preview and on-chain handler will compute
 * different floors and the cranker's quote-vs-floor decision becomes a
 * lie.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  applySlippageFloor,
  calculateStepPrice,
  depositExpectedOut,
  MAX_SLIPPAGE_BPS,
  ONRE_OFFER_ACCOUNT_SIZE,
  ONRE_OFFER_MAX_VECTORS,
  ONRE_OFFER_VECTOR_SIZE,
  ONRE_OFFER_VECTORS_OFFSET,
  parseActiveOfferVector,
  redemptionExpectedOut,
  synthOfferBuffer,
} from '@fogo-onre/sdk'
import { describe, expect, it } from 'vitest'

describe('applySlippageFloor', () => {
  it('zero bps is identity', () => {
    expect(applySlippageFloor(1_000_000n, 0)).toBe(1_000_000n)
  })

  it('50 bps is half-percent haircut', () => {
    expect(applySlippageFloor(1_000_000n, 50)).toBe(995_000n)
  })

  it('exact 10_000 bps yields zero', () => {
    expect(applySlippageFloor(1_000_000n, 10_000)).toBe(0n)
  })

  it('rejects misconfigured >10_000 bps', () => {
    expect(() => applySlippageFloor(1_000_000n, 10_001)).toThrow(/OnreInvalidSlippageBps/)
  })

  it('handles u64::MAX gross without intermediate overflow', () => {
    const u64Max = (1n << 64n) - 1n
    const expected = (u64Max * 9_950n) / 10_000n
    expect(applySlippageFloor(u64Max, 50)).toBe(expected)
  })
})

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
 * Drift tripwire — paired with `offer_layout_matches_fixture` in
 * `programs/relayer/src/onre.rs`. If OnRe re-lays out `Offer`, both
 * suites must fire together; if only one fires, TS preview and
 * on-chain handler disagree on what `Offer` even *is*.
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

    const active = parseActiveOfferVector(data, 2_000_000_000n)
    expect(active.start_time).toBe(1_773_878_400n)
    expect(active.base_price).toBe(1_085_708_975n)
    expect(active.apr).toBe(97_593n)
    expect(active.price_fix_duration).toBe(86_400n)
  })
})

/**
 * Drift tripwire — pairs the TS-side `MAX_SLIPPAGE_BPS` mirror against
 * the on-chain `pub const MAX_SLIPPAGE_BPS: u16` in
 * `programs/relayer/src/constants.rs`. The Rust constant isn't
 * `#[constant]`-annotated so the IDL doesn't carry it; we close the
 * loop with a regex grep at test time.
 *
 * If this fires, both sides need a coordinated bump in the same
 * commit — otherwise the cranker computes the wrong NAV floor and
 * mis-classifies quote outcomes.
 */
describe('max-slippage-bps rust mirror', () => {
  it('matches the on-chain constants.rs value', () => {
    const constantsPath = resolve(
      __dirname,
      '../programs/relayer/src/constants.rs',
    )
    const src = readFileSync(constantsPath, 'utf8')
    const match = src.match(/pub\s+const\s+MAX_SLIPPAGE_BPS\s*:\s*u16\s*=\s*(\d+)\s*;/)
    if (!match) {
      throw new Error(
        'Could not find `pub const MAX_SLIPPAGE_BPS: u16 = N;` in '
        + `${constantsPath}. Either the constant was renamed/retyped, or this `
        + 'test\'s regex needs updating. Either case requires hand review — '
        + 'do not silently update the regex without confirming the on-chain '
        + 'semantics still match `applySlippageFloor` in onre-nav.ts.',
      )
    }
    const onChainValue = Number(match[1])
    expect(onChainValue).toBe(MAX_SLIPPAGE_BPS)
  })
})
