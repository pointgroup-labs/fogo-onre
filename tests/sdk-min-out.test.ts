/**
 * Phase 4 — client `min_out` computation. `computeMinSwapOut` is the
 * value the user signs as the swap floor; it MUST be computed against the
 * NTT POST-TRIM input (spec §10/G2) and net of the on-chain withdraw fee
 * (taken from the input before the swap), then haircut by the user's
 * slippage. These tests pin the math against the same OnRe NAV mirrors the
 * on-chain `swap` floor uses, so a "clears floor" preview matches execution.
 */

import {
  applyNttTrim,
  calculateStepPrice,
  computeMinSwapOut,
  DEFAULT_SLIPPAGE_TOLERANCE_BPS,
  depositExpectedOut,
  ONYC_DECIMALS,
  parseActiveOfferVector,
  redemptionExpectedOut,
  synthOfferBuffer,
  USDC_DECIMALS,
} from '@fogo-onre/sdk'
import { describe, expect, it } from 'vitest'

// A flat (apr=0) vector active for any `now >= start`. base_price 1e9 with
// equal decimals = 1:1 ONyc/USDC, so expected-out math is easy to eyeball.
function flatOffer(basePrice: bigint): Uint8Array {
  return synthOfferBuffer([
    { start_time: 1_000n, base_time: 1_000n, base_price: basePrice, apr: 0n, price_fix_duration: 86_400n },
  ])
}

const NOW = 2_000n

describe('applyNttTrim', () => {
  it('is identity when decimals <= 8 (USDC 6dp)', () => {
    expect(applyNttTrim(1_234_567n, 6)).toBe(1_234_567n)
    expect(applyNttTrim(1n, 8)).toBe(1n)
  })

  it('drops sub-8-decimal precision for ONyc (9dp → floor to 8dp scale)', () => {
    // 9dp → trim to 8dp: factor 10. Last digit is dropped (floored).
    expect(applyNttTrim(1_234_567_899n, 9)).toBe(1_234_567_890n)
    expect(applyNttTrim(9n, 9)).toBe(0n)
    expect(applyNttTrim(10n, 9)).toBe(10n)
  })

  it('floors a 18dp amount to 8dp scale', () => {
    // factor 10^10
    expect(applyNttTrim(12_345_678_999_999_999_999n, 18)).toBe(12_345_678_990_000_000_000n)
  })

  it('rejects out-of-range decimals', () => {
    expect(() => applyNttTrim(1n, -1)).toThrow()
    expect(() => applyNttTrim(1n, 256)).toThrow()
  })
})

describe('computeMinSwapOut — deposit (USDC → ONyc)', () => {
  it('floor = depositExpectedOut(postTrim) haircut by slippage, gross basis', () => {
    const offerData = flatOffer(1_000_000_000n) // 1:1
    const postTrimInAmount = 1_000_000n // 1 USDC (6dp, no trim loss)
    const price = calculateStepPrice(parseActiveOfferVector(offerData, NOW), NOW)
    const gross = depositExpectedOut(postTrimInAmount, price, USDC_DECIMALS, ONYC_DECIMALS)
    const slippageBps = 100
    const expected = (gross * (10_000n - BigInt(slippageBps))) / 10_000n

    const got = computeMinSwapOut({
      direction: 'deposit',
      postTrimInAmount,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps,
    })
    expect(got).toBe(expected)
  })

  it('does NOT subtract the deposit fee (on-chain floor is gross output)', () => {
    const offerData = flatOffer(1_000_000_000n)
    const postTrimInAmount = 1_000_000n
    // With or without a withdrawFeeBps passed, deposit ignores it.
    const a = computeMinSwapOut({
      direction: 'deposit',
      postTrimInAmount,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 100,
    })
    const b = computeMinSwapOut({
      direction: 'deposit',
      postTrimInAmount,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 100,
      withdrawFeeBps: 50,
    })
    expect(a).toBe(b)
  })

  it('zero slippage is the exact gross expected-out (boundary)', () => {
    const offerData = flatOffer(2_000_000_000n) // 2 USDC/ONyc → halves ONyc out
    const postTrimInAmount = 4_000_000n // 4 USDC
    const price = calculateStepPrice(parseActiveOfferVector(offerData, NOW), NOW)
    const gross = depositExpectedOut(postTrimInAmount, price, USDC_DECIMALS, ONYC_DECIMALS)
    const got = computeMinSwapOut({
      direction: 'deposit',
      postTrimInAmount,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 0,
    })
    expect(got).toBe(gross)
  })
})

describe('computeMinSwapOut — withdraw (ONyc → USDC)', () => {
  it('floor = redemptionExpectedOut(net-of-withdraw-fee) haircut by slippage', () => {
    const offerData = flatOffer(1_000_000_000n) // 1:1
    const postTrimInAmount = 1_000_000_000n // 1 ONyc (9dp, already trim-aligned)
    const withdrawFeeBps = 50
    const slippageBps = 100

    const fee = (postTrimInAmount * BigInt(withdrawFeeBps)) / 10_000n
    const net = postTrimInAmount - fee
    const price = calculateStepPrice(parseActiveOfferVector(offerData, NOW), NOW)
    const gross = redemptionExpectedOut(net, price, ONYC_DECIMALS, USDC_DECIMALS)
    const expected = (gross * (10_000n - BigInt(slippageBps))) / 10_000n

    const got = computeMinSwapOut({
      direction: 'withdraw',
      postTrimInAmount,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps,
      withdrawFeeBps,
    })
    expect(got).toBe(expected)
  })

  it('withdraw fee defaults to 0 when omitted (net == gross input)', () => {
    const offerData = flatOffer(1_000_000_000n)
    const postTrimInAmount = 1_000_000_000n
    const price = calculateStepPrice(parseActiveOfferVector(offerData, NOW), NOW)
    const gross = redemptionExpectedOut(postTrimInAmount, price, ONYC_DECIMALS, USDC_DECIMALS)
    const got = computeMinSwapOut({
      direction: 'withdraw',
      postTrimInAmount,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 0,
    })
    expect(got).toBe(gross)
  })

  it('a larger withdraw fee lowers the floor', () => {
    const offerData = flatOffer(1_000_000_000n)
    const args = {
      direction: 'withdraw' as const,
      postTrimInAmount: 1_000_000_000n,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 0,
    }
    const lowFee = computeMinSwapOut({ ...args, withdrawFeeBps: 10 })
    const highFee = computeMinSwapOut({ ...args, withdrawFeeBps: 200 })
    expect(highFee).toBeLessThan(lowFee)
  })
})

describe('computeMinSwapOut — post-trim basis (spec §10/G2)', () => {
  it('trims a sub-8dp ONyc withdraw input before pricing', () => {
    const offerData = flatOffer(1_000_000_000n)
    // 1.999999999 ONyc: the trailing 9 is below the 8dp trim floor.
    const rawIn = 1_999_999_999n
    const trimmed = applyNttTrim(rawIn, ONYC_DECIMALS) // 1_999_999_990
    expect(trimmed).toBe(1_999_999_990n)

    // The function takes the post-trim amount directly (caller trims first),
    // so passing the trimmed value is what binds the floor to what the
    // relayer sees. Passing the raw value would over-state the floor.
    const onTrimmed = computeMinSwapOut({
      direction: 'withdraw',
      postTrimInAmount: trimmed,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 0,
    })
    const onRaw = computeMinSwapOut({
      direction: 'withdraw',
      postTrimInAmount: rawIn,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 0,
    })
    expect(onTrimmed).toBeLessThanOrEqual(onRaw)
  })
})

describe('computeMinSwapOut — guards & default', () => {
  it('exposes a sane default slippage tolerance constant', () => {
    expect(DEFAULT_SLIPPAGE_TOLERANCE_BPS).toBe(100)
  })

  it('rejects an out-of-range slippage', () => {
    const offerData = flatOffer(1_000_000_000n)
    const base = {
      direction: 'deposit' as const,
      postTrimInAmount: 1_000_000n,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
    }
    expect(() => computeMinSwapOut({ ...base, slippageBps: -1 })).toThrow()
    expect(() => computeMinSwapOut({ ...base, slippageBps: 10_001 })).toThrow()
  })

  it('rejects a non-positive post-trim input', () => {
    const offerData = flatOffer(1_000_000_000n)
    expect(() => computeMinSwapOut({
      direction: 'deposit',
      postTrimInAmount: 0n,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 100,
    })).toThrow()
  })

  it('rejects a computed floor of zero (on-chain receive rejects min == 0)', () => {
    // 100% slippage haircuts the floor to 0, which on-chain treats as "no
    // floor" and rejects — fail closed client-side instead.
    const offerData = flatOffer(1_000_000_000n)
    expect(() => computeMinSwapOut({
      direction: 'deposit',
      postTrimInAmount: 1_000_000n,
      offerData,
      nowUnix: NOW,
      baseDecimals: USDC_DECIMALS,
      onycDecimals: ONYC_DECIMALS,
      slippageBps: 10_000,
    })).toThrow()
  })
})
