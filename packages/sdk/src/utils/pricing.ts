import { FEE_DENOMINATOR_BPS, MAX_FEE_BPS, ONYC_DECIMALS, SECONDS_PER_YEAR, USDC_DECIMALS } from '../constants'

/**
 * Fee + price math, mirroring on-chain `apply_fee_bps`
 * (`programs/relayer/src/state.rs`) and the OnRe price-vector formula so UI
 * quotes can't diverge from execution. All amounts are bigints in the
 * token's smallest unit (USDC 6dp, ONyc 9dp); floats are avoided so
 * rounding matches the program exactly.
 */

export interface FeeBreakdown {
  /** Amount the user keeps after the fee (matches on-chain `net`). */
  net: bigint
  /** Amount routed to the protocol's `fee_vault` (matches on-chain `fee`). */
  fee: bigint
}

/**
 * Mirrors `apply_fee_bps`: `fee = floor(gross * bps / 10_000)`,
 * `net = gross - fee` (must be > 0). Throws on the same conditions the
 * program errors on: `bps` outside `[0, MAX_FEE_BPS]`, `gross <= 0`, `net <= 0`.
 */
export function applyFeeBps(gross: bigint, bps: number): FeeBreakdown {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) {
    throw new RangeError(`bps must be an integer in [0, ${MAX_FEE_BPS}], got ${bps}`)
  }
  if (gross <= 0n) {
    throw new RangeError('gross must be > 0')
  }
  const fee = (gross * BigInt(bps)) / FEE_DENOMINATOR_BPS
  const net = gross - fee
  if (net <= 0n) {
    throw new RangeError('net would be 0 (gross too small for this bps)')
  }
  return { net, fee }
}

/**
 * Snapshot of the OnRe price-vector at a point in time.
 *
 * `basePrice / priceScale` is the base-unit ratio (USDC base units per ONyc
 * base unit). With USDC 6dp / ONyc 9dp, human 1.00 USDC/ONyc = ratio 0.001,
 * stored as `basePrice = 1_000_000n` at `priceScale = 1_000_000_000n`. Use
 * `humanPriceToBaseRatio` at the boundary; the quote functions stay
 * decimal-agnostic on base-unit amounts.
 */
export interface OnycPriceSnapshot {
  basePrice: bigint
  priceScale: bigint
  /** Annualised yield in bps (10_000 = 100%). */
  aprBps: number
  /** Unix seconds at which `basePrice` was set on-chain. */
  startTimestamp: bigint
}

/**
 * Convert a human USDC-per-ONyc price into the base-unit ratio for
 * `OnycPriceSnapshot.basePrice`:
 *   baseRatio = humanPriceScaled * 10^USDC_DECIMALS / 10^ONYC_DECIMALS
 * Pass `humanPriceScaled` pre-multiplied by `priceScale` (e.g. `1_100_000_000n` for "1.10").
 */
export function humanPriceToBaseRatio(humanPriceScaled: bigint): bigint {
  const usdcUnits = 10n ** BigInt(USDC_DECIMALS)
  const onycUnits = 10n ** BigInt(ONYC_DECIMALS)
  return (humanPriceScaled * usdcUnits) / onycUnits
}

/**
 * Spot ONyc price at `nowSeconds`, accruing linearly from `startTimestamp`:
 *   onyc_price = basePrice * (1 + aprBps/10_000 * elapsed / SECONDS_PER_YEAR)
 * Returns `basePrice` unchanged for times before `startTimestamp`.
 */
export function computeOnycPrice(snapshot: OnycPriceSnapshot, nowSeconds: bigint): bigint {
  const elapsed = nowSeconds > snapshot.startTimestamp
    ? nowSeconds - snapshot.startTimestamp
    : 0n
  if (elapsed === 0n || snapshot.aprBps === 0) {
    return snapshot.basePrice
  }
  const accrued = (snapshot.basePrice * BigInt(snapshot.aprBps) * elapsed)
    / (FEE_DENOMINATOR_BPS * SECONDS_PER_YEAR)
  return snapshot.basePrice + accrued
}

export interface DepositQuote {
  /** USDC the user supplies (decimals = USDC_DECIMALS). */
  inputUsdc: bigint
  /** Gross ONyc the swap would produce before the deposit-leg fee. */
  grossOnyc: bigint
  /** ONyc skimmed to `fee_vault` (decimals = ONYC_DECIMALS). */
  feeOnyc: bigint
  /** Net ONyc the user receives — bridged 1:1 as ONyc on FOGO. */
  outputFogoOnyc: bigint
}

/**
 * Quote a deposit (USDC → ONyc on FOGO), mirroring the on-chain chain:
 *   1. swap `inputUsdc` to ONyc at OnRe → `grossOnyc = inputUsdc * priceScale / onycPrice`
 *   2. `apply_deposit_fee` skims `feeOnyc` → `applyFeeBps(grossOnyc, depositFeeBps)`
 *   3. NTT locks the net and mints ONyc 1:1 to the user.
 */
export function quoteDeposit(params: {
  inputUsdc: bigint
  depositFeeBps: number
  onycPrice: bigint
  priceScale: bigint
}): DepositQuote {
  const { inputUsdc, depositFeeBps, onycPrice, priceScale } = params
  if (onycPrice <= 0n) {
    throw new RangeError('onycPrice must be > 0')
  }
  const grossOnyc = (inputUsdc * priceScale) / onycPrice
  const { net, fee } = applyFeeBps(grossOnyc, depositFeeBps)
  return { inputUsdc, grossOnyc, feeOnyc: fee, outputFogoOnyc: net }
}

export interface WithdrawQuote {
  /** ONyc the user supplies. NTT-burns 1:1 into ONyc on Solana. */
  inputFogoOnyc: bigint
  /** ONyc skimmed to `fee_vault`. */
  feeOnyc: bigint
  /** Net ONyc forwarded to OnRe for redemption. */
  netOnyc: bigint
  /** Approximate USDC.s the user receives. */
  outputUsdc: bigint
}

/**
 * Quote a withdraw (ONyc → USDC on FOGO), mirroring the on-chain chain:
 *   1. NTT burns `inputFogoOnyc` and releases ONyc to the relayer.
 *   2. `apply_withdraw_fee` skims `feeOnyc`.
 *   3. relayer redeems `netOnyc` at OnRe → `outputUsdc = netOnyc * onycPrice / priceScale`.
 *
 * Actual USDC is set by OnRe at fulfilment; this uses the snapshot price, so
 * display `outputUsdc` as approximate.
 */
export function quoteWithdraw(params: {
  inputFogoOnyc: bigint
  withdrawFeeBps: number
  onycPrice: bigint
  priceScale: bigint
}): WithdrawQuote {
  const { inputFogoOnyc, withdrawFeeBps, onycPrice, priceScale } = params
  if (onycPrice <= 0n) {
    throw new RangeError('onycPrice must be > 0')
  }
  const { net, fee } = applyFeeBps(inputFogoOnyc, withdrawFeeBps)
  const outputUsdc = (net * onycPrice) / priceScale
  return { inputFogoOnyc, feeOnyc: fee, netOnyc: net, outputUsdc }
}
