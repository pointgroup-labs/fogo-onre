import type { OnycPriceSnapshot } from '@fogo-onre/sdk'
import {
  applyFeeBps,
  computeOnycPrice,
  FEE_DENOMINATOR_BPS,
  humanPriceToBaseRatio,
  MAX_FEE_BPS,
  quoteDeposit,
  quoteWithdraw,
  SECONDS_PER_YEAR,
} from '@fogo-onre/sdk'
import { describe, expect, it } from 'vitest'

// USDC = 6 decimals, ONyc = 9 decimals.
// Base-unit ratio for "1.0 USDC per 1 ONyc" = 1e6 / 1e9 = 0.001,
// stored at PRICE_SCALE=1e9 as 1_000_000.
const PRICE_SCALE = 1_000_000_000n
const ONE_USDC = 1_000_000n
const ONE_ONYC = 1_000_000_000n
const UNIT_RATIO = 1_000_000n // "1.0 USDC/ONyc" in base units, scaled by PRICE_SCALE

describe('applyFeeBps', () => {
  it('matches floor(gross * bps / 10_000)', () => {
    expect(applyFeeBps(1_000_000n, 25)).toEqual({ net: 997_500n, fee: 2_500n })
    expect(applyFeeBps(10_000n, 1)).toEqual({ net: 9_999n, fee: 1n })
  })

  it('rounds the fee down (matches u128 integer division on-chain)', () => {
    expect(applyFeeBps(9_999n, 25)).toEqual({ net: 9_975n, fee: 24n })
  })

  it('zero bps means zero fee', () => {
    expect(applyFeeBps(123_456n, 0)).toEqual({ net: 123_456n, fee: 0n })
  })

  it('rejects bps above the relayer cap', () => {
    expect(() => applyFeeBps(1_000_000n, MAX_FEE_BPS + 1)).toThrow(RangeError)
  })

  it('rejects non-positive gross', () => {
    expect(() => applyFeeBps(0n, 25)).toThrow(RangeError)
    expect(() => applyFeeBps(-1n, 25)).toThrow(RangeError)
  })

  // eslint-disable-next-line test/prefer-lowercase-title
  it('FEE_DENOMINATOR_BPS sanity', () => {
    expect(FEE_DENOMINATOR_BPS).toBe(10_000n)
  })
})

describe('humanPriceToBaseRatio', () => {
  it('converts a human "1.0 USDC/ONyc" (scaled by 1e9) to the base-unit ratio', () => {
    expect(humanPriceToBaseRatio(1_000_000_000n)).toBe(UNIT_RATIO)
  })

  it('handles "1.10 USDC/ONyc"', () => {
    expect(humanPriceToBaseRatio(1_100_000_000n)).toBe(1_100_000n)
  })
})

describe('computeOnycPrice', () => {
  const snapshot: OnycPriceSnapshot = {
    basePrice: UNIT_RATIO,
    priceScale: PRICE_SCALE,
    aprBps: 1_000, // 10%
    startTimestamp: 1_700_000_000n,
  }

  it('returns basePrice at t = startTimestamp', () => {
    expect(computeOnycPrice(snapshot, snapshot.startTimestamp)).toBe(UNIT_RATIO)
  })

  it('returns basePrice for times before startTimestamp (no extrapolation)', () => {
    expect(computeOnycPrice(snapshot, snapshot.startTimestamp - 1_000n)).toBe(UNIT_RATIO)
  })

  it('after one full year at 10% APR, price is 1.10x basePrice', () => {
    const oneYearLater = snapshot.startTimestamp + SECONDS_PER_YEAR
    expect(computeOnycPrice(snapshot, oneYearLater)).toBe(1_100_000n)
  })

  it('linear over time', () => {
    const halfYearLater = snapshot.startTimestamp + SECONDS_PER_YEAR / 2n
    expect(computeOnycPrice(snapshot, halfYearLater)).toBe(1_050_000n)
  })

  it('zero APR means flat price', () => {
    const flat: OnycPriceSnapshot = { ...snapshot, aprBps: 0 }
    const t = snapshot.startTimestamp + SECONDS_PER_YEAR * 5n
    expect(computeOnycPrice(flat, t)).toBe(flat.basePrice)
  })
})

describe('quoteDeposit', () => {
  it('1 USDC at unit price -> 1 ONyc gross, 25bps fee skimmed', () => {
    const q = quoteDeposit({
      inputUsdc: ONE_USDC,
      depositFeeBps: 25,
      onycPrice: UNIT_RATIO,
      priceScale: PRICE_SCALE,
    })
    expect(q.grossOnyc).toBe(ONE_ONYC)
    expect(q.feeOnyc).toBe(2_500_000n)
    expect(q.outputFogoOnyc).toBe(997_500_000n)
  })

  it('handles non-unit ONyc price (1.10 USDC per ONyc)', () => {
    // gross = 1_000_000 * 1e9 / 1_100_000 = 909_090_909
    const q = quoteDeposit({
      inputUsdc: ONE_USDC,
      depositFeeBps: 0,
      onycPrice: 1_100_000n,
      priceScale: PRICE_SCALE,
    })
    expect(q.grossOnyc).toBe(909_090_909n)
    expect(q.outputFogoOnyc).toBe(909_090_909n)
  })

  it('rejects zero price', () => {
    expect(() => quoteDeposit({
      inputUsdc: ONE_USDC,
      depositFeeBps: 0,
      onycPrice: 0n,
      priceScale: PRICE_SCALE,
    })).toThrow(RangeError)
  })
})

describe('quoteWithdraw', () => {
  it('1 ONyc at unit price, 0 fee -> 1 USDC out', () => {
    const q = quoteWithdraw({
      inputFogoOnyc: ONE_ONYC,
      withdrawFeeBps: 0,
      onycPrice: UNIT_RATIO,
      priceScale: PRICE_SCALE,
    })
    expect(q.netOnyc).toBe(ONE_ONYC)
    expect(q.outputUsdc).toBe(ONE_USDC)
  })

  it('skims fee in ONyc before redeeming at 1.10 price', () => {
    // fee = 2_500_000 ONyc base, net = 997_500_000
    // usdc = 997_500_000 * 1_100_000 / 1e9 = 1_097_250
    const q = quoteWithdraw({
      inputFogoOnyc: ONE_ONYC,
      withdrawFeeBps: 25,
      onycPrice: 1_100_000n,
      priceScale: PRICE_SCALE,
    })
    expect(q.feeOnyc).toBe(2_500_000n)
    expect(q.netOnyc).toBe(997_500_000n)
    expect(q.outputUsdc).toBe(1_097_250n)
  })
})
