/**
 * TS mirror of OnRe NAV math + Offer-account byte layout, paired
 * byte-for-byte with `programs/relayer/src/onre.rs` (the Rust side has the
 * `offer_layout_matches_fixture` tripwire; this module's tests pin the
 * same constants). Consumers compute the same NAV floor `swap` enforces
 * on-chain — drift means a "clears floor" quote gets rejected by the chain.
 *
 * `bigint` (not Number): intermediate products exceed 2^53 and would lose
 * precision in IEEE-754. Throws (not Result): callers wrap in try/catch.
 */

// Pinned constants — mirror `programs/relayer/src/constants.rs:135-147`.
export const ONRE_OFFER_ACCOUNT_SIZE = 608
export const ONRE_OFFER_VECTORS_OFFSET = 72
export const ONRE_OFFER_VECTOR_SIZE = 40
export const ONRE_OFFER_MAX_VECTORS = 10
export const ONRE_PRICE_DENOMINATOR = 1_000_000_000n
export const ONRE_APR_SCALE = 1_000_000n
export const ONRE_SECONDS_IN_YEAR = 31_536_000n

/**
 * Mirror of the on-chain `MAX_SLIPPAGE_BPS` compile-time constant
 * (`programs/relayer/src/constants.rs`) — the hard ceiling on the
 * authority-configurable `RelayerConfig.slippage_bps`. Drift tripwire
 * only; the floor preview uses the *configured* slippage, not this cap.
 */
export const MAX_SLIPPAGE_BPS = 200

/**
 * Mirror of the on-chain `DEFAULT_SLIPPAGE_BPS` (seeded at `initialize`).
 * Use as the floor-preview slippage when the live config is unavailable.
 */
export const DEFAULT_SLIPPAGE_BPS = 10

const U64_MAX = (1n << 64n) - 1n

export interface OnreOfferVector {
  start_time: bigint
  base_time: bigint
  base_price: bigint
  apr: bigint
  price_fix_duration: bigint
}

function asU64(x: bigint, label: string): bigint {
  if (x < 0n || x > U64_MAX) {
    throw new Error(`OnreNavOverflow: ${label} out of u64 range`)
  }
  return x
}

/**
 * Mirror of `apply_slippage_floor`. Fail-closed on `bps > 10_000`.
 */
export function applySlippageFloor(grossExpected: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('OnreInvalidSlippageBps: slippage out of [0, 10_000]')
  }
  const factor = 10_000n - BigInt(slippageBps)
  const prod = grossExpected * factor
  return asU64(prod / 10_000n, 'apply_slippage_floor result')
}

/**
 * Mirror of `redemption_expected_out`. Returns gross USDC for a
 * `tokenInAmount` of ONyc at `price` (1e9 fixed-point). Mirrors OnRe's
 * pre-fee output; the relayer takes its withdraw fee elsewhere.
 */
export function redemptionExpectedOut(
  tokenInAmount: bigint,
  price: bigint,
  tokenInDecimals: number,
  tokenOutDecimals: number,
): bigint {
  const powIn = 10n ** BigInt(tokenInDecimals)
  const powOut = 10n ** BigInt(tokenOutDecimals)
  const num = tokenInAmount * price * powOut
  const den = powIn * ONRE_PRICE_DENOMINATOR
  return asU64(num / den, 'redemption_expected_out result')
}

/**
 * Mirror of `deposit_expected_out` (USDC in → ONyc out), the algebraic
 * inverse of `redemptionExpectedOut`. Lets the cranker/webapp preview the
 * deposit-leg NAV floor that `swap` enforces on-chain.
 */
export function depositExpectedOut(
  usdcInAmount: bigint,
  price: bigint,
  usdcDecimals: number,
  onycDecimals: number,
): bigint {
  if (price <= 0n) {
    throw new Error('OnreNoActiveVector: price must be positive')
  }
  const powOut = 10n ** BigInt(onycDecimals)
  const powIn = 10n ** BigInt(usdcDecimals)
  const num = usdcInAmount * powOut * ONRE_PRICE_DENOMINATOR
  const den = price * powIn
  return asU64(num / den, 'deposit_expected_out result')
}

/**
 * Mirror of `parse_active_offer_vector`. Picks the vector with the
 * largest `start_time` satisfying `start_time != 0 && start_time <= now`.
 * Iterates exactly `ONRE_OFFER_MAX_VECTORS` slots.
 */
export function parseActiveOfferVector(data: Uint8Array, now: bigint): OnreOfferVector {
  if (data.length < ONRE_OFFER_ACCOUNT_SIZE) {
    throw new Error('OnreOfferTooShort: account data shorter than pinned layout')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let best: OnreOfferVector | null = null
  for (let i = 0; i < ONRE_OFFER_MAX_VECTORS; i++) {
    const off = ONRE_OFFER_VECTORS_OFFSET + i * ONRE_OFFER_VECTOR_SIZE
    const v: OnreOfferVector = {
      start_time: view.getBigUint64(off, true),
      base_time: view.getBigUint64(off + 8, true),
      base_price: view.getBigUint64(off + 16, true),
      apr: view.getBigUint64(off + 24, true),
      price_fix_duration: view.getBigUint64(off + 32, true),
    }
    if (v.start_time === 0n || v.start_time > now) {
      continue
    }
    if (best === null || v.start_time > best.start_time) {
      best = v
    }
  }
  if (best === null) {
    throw new Error('OnreNoActiveVector: no qualifying pricing vector for current clock')
  }
  return best
}

/**
 * Mirror of `calculate_step_price`. Snaps to the END of the current
 * discrete step — must match `swap`'s on-chain snap
 * exactly, or cranker preview and on-chain handler diverge.
 */
export function calculateStepPrice(v: OnreOfferVector, now: bigint): bigint {
  if (v.base_time > now) {
    throw new Error('OnreNoActiveVector: now < base_time')
  }
  if (v.price_fix_duration === 0n) {
    throw new Error('OnreNoActiveVector: price_fix_duration == 0')
  }
  const elapsed = now - v.base_time
  const step = elapsed / v.price_fix_duration
  const stepEnd = (step + 1n) * v.price_fix_duration

  const factorDen = ONRE_APR_SCALE * ONRE_SECONDS_IN_YEAR
  const yPart = v.apr * stepEnd
  const factorNum = factorDen + yPart

  const priceU128 = (v.base_price * factorNum) / factorDen
  return asU64(priceU128, 'calculate_step_price result')
}

/**
 * Test helper — synthesises an `Offer` byte buffer at the same offsets
 * the parser reads. Exported so the paired test exercises the byte
 * layout, not just the pure math.
 */
export function synthOfferBuffer(vectors: ReadonlyArray<OnreOfferVector>): Uint8Array {
  const data = new Uint8Array(ONRE_OFFER_ACCOUNT_SIZE)
  const view = new DataView(data.buffer)
  const limit = Math.min(vectors.length, ONRE_OFFER_MAX_VECTORS)
  for (let i = 0; i < limit; i++) {
    const v = vectors[i]
    const off = ONRE_OFFER_VECTORS_OFFSET + i * ONRE_OFFER_VECTOR_SIZE
    view.setBigUint64(off, v.start_time, true)
    view.setBigUint64(off + 8, v.base_time, true)
    view.setBigUint64(off + 16, v.base_price, true)
    view.setBigUint64(off + 24, v.apr, true)
    view.setBigUint64(off + 32, v.price_fix_duration, true)
  }
  return data
}
