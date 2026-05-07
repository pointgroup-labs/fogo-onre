import { FEE_DENOMINATOR_BPS, MAX_FEE_BPS, ONYC_DECIMALS, SECONDS_PER_YEAR, USDC_DECIMALS } from '../constants'

/**
 * Fee + price math for the relayer.
 *
 * All math here mirrors on-chain behaviour exactly so quotes a UI shows
 * cannot diverge from what the program will execute. Mirrors:
 *   - `apply_fee_bps`            (programs/relayer/src/state.rs)
 *   - the OnRe price-vector formula in docs/architecture.md
 *
 * Inputs and outputs are bigints denominated in the smallest unit of the
 * relevant token. USDC uses 6 decimals, ONyc uses 9 decimals — see
 * USDC_DECIMALS / ONYC_DECIMALS. Floats and Number arithmetic are
 * intentionally avoided so quotes round identically to the program.
 */

export interface FeeBreakdown {
  /** Amount the user keeps after the fee (matches on-chain `net`). */
  net: bigint
  /** Amount routed to the protocol's `fee_vault` (matches on-chain `fee`). */
  fee: bigint
}

/**
 * Mirrors `apply_fee_bps` in `programs/relayer/src/state.rs`:
 *
 *   fee = floor(gross * bps / 10_000)
 *   net = gross - fee, must be > 0
 *
 * Throws on the same conditions the program would error on (rather than
 * surfacing them as Anchor errors deep inside a CPI):
 *   - `bps` outside `[0, MAX_FEE_BPS]` (program: `FeeBpsTooHigh`)
 *   - `gross <= 0` or resulting `net <= 0` (program: `ZeroAmountFlow`)
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
 * Snapshot of the OnRe price-vector at a known point in time. Matches the
 * cached parameters maintained by OnRe and refreshed via Wormhole Queries
 * or governance.
 *
 * **Convention.** `basePrice` and `priceScale` together represent the
 * **base-unit ratio** of USDC to ONyc, scaled as fixed-point:
 *
 *   real_ratio = basePrice / priceScale     (USDC base units per ONyc base unit)
 *
 * USDC is 6 decimals and ONyc is 9 decimals, so the human price 1.00 USDC
 * per 1 ONyc corresponds to a base-unit ratio of `1e6 / 1e9 = 0.001`.
 * Concretely, with `priceScale = 1_000_000_000n`, that human price is
 * stored as `basePrice = 1_000_000n`.
 *
 * Use `humanPriceToBaseRatio` at the boundary (UI inputs, config files,
 * test fixtures) to convert between human prices and this representation.
 * The quote functions below stay decimal-agnostic and operate purely on
 * base-unit amounts and base-unit ratios.
 *
 * Picking `priceScale = 1_000_000_000n` gives 9 digits of resolution which
 * is comfortably more than enough for ONyc's APR over realistic intervals.
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
 * Convert a human-readable USDC-per-ONyc price (e.g. "1.10 USDC per ONyc")
 * into the base-unit ratio expected by `OnycPriceSnapshot.basePrice`.
 *
 *   baseRatio = humanPriceScaled * 10^USDC_DECIMALS / 10^ONYC_DECIMALS
 *
 * Pass `humanPriceScaled` already multiplied by `priceScale` to avoid float
 * intermediates. For "1.10" with priceScale=1e9, pass `1_100_000_000n`.
 */
export function humanPriceToBaseRatio(humanPriceScaled: bigint): bigint {
  const usdcUnits = 10n ** BigInt(USDC_DECIMALS)
  const onycUnits = 10n ** BigInt(ONYC_DECIMALS)
  return (humanPriceScaled * usdcUnits) / onycUnits
}

/**
 * Spot ONyc price at `nowSeconds`, accruing linearly from `startTimestamp`:
 *
 *   onyc_price = basePrice * (1 + aprBps/10_000 * elapsed / SECONDS_PER_YEAR)
 *
 * Returned as a fixed-point bigint with the same `priceScale` as the input.
 * For times before `startTimestamp`, returns `basePrice` unchanged (no
 * extrapolation backwards — the cached params don't apply yet).
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
 * Quote a deposit (USDC.s on FOGO → ONyc on FOGO).
 *
 * Steps mirror the on-chain deposit chain:
 *   1. relayer swaps `inputUsdc` to ONyc at OnRe at the current price
 *      → `grossOnyc = inputUsdc * priceScale / onycPrice`
 *   2. `apply_deposit_fee` skims `feeOnyc` to `fee_vault`
 *      → `(outputFogoOnyc, feeOnyc) = applyFeeBps(grossOnyc, depositFeeBps)`
 *   3. NTT locks `outputFogoOnyc` ONyc and mints ONyc 1:1 to the user.
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
 * Quote a withdraw (ONyc on FOGO → USDC.s on FOGO).
 *
 * Steps mirror the on-chain withdraw chain:
 *   1. NTT burns `inputFogoOnyc` ONyc on FOGO; releases `inputFogoOnyc` ONyc to the relayer.
 *   2. `apply_withdraw_fee` skims `feeOnyc` to `fee_vault`.
 *   3. relayer requests redemption of `netOnyc` from OnRe.
 *      → `outputUsdc = netOnyc * onycPrice / priceScale`
 *   4. (async) OnRe's `redemption_admin` fulfils, then the relayer NTT-sends
 *      USDC.s back to the user.
 *
 * The actual USDC delivered is set by OnRe at fulfilment time; this quote uses
 * the snapshot price the caller passes in. Display it as approximate.
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
