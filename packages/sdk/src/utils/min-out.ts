/**
 * Client-side swap-floor (`min_out`) computation — the value the user signs
 * and the relayer enforces in `swap` (`out_received >= flow.min_swap_out`).
 *
 * The floor MUST match the on-chain basis exactly or an honest swap reverts:
 *   - it is computed against the NTT POST-TRIM input (spec §10/G2), so the
 *     caller passes `postTrimInAmount` (use `applyNttTrim`), not the raw UI
 *     amount;
 *   - deposit floors the GROSS OnRe output (the deposit fee is skimmed AFTER
 *     the check on-chain), so the deposit fee is NOT subtracted here;
 *   - withdraw floors USDC out for the NET ONyc input (the withdraw fee is
 *     taken from the input BEFORE the swap), so the fee is subtracted first.
 *
 * The slippage haircut covers venue execution (OnRe `take_offer` fee /
 * Jupiter) + market drift; too tight just reverts on-chain (fail-safe).
 */

import { calculateStepPrice, depositExpectedOut, parseActiveOfferVector, redemptionExpectedOut } from './onre-nav'

/** NTT normalizes transfers to this many decimals; precision below is dropped. */
export const NTT_TRIMMING_DECIMALS = 8

/** Default user slippage tolerance (1%). Covers venue fee + bridge-latency drift. */
export const DEFAULT_SLIPPAGE_TOLERANCE_BPS = 100

const BPS_DENOMINATOR = 10_000n

/**
 * Apply the NTT amount trim: normalize to `min(8, decimals)` and re-scale
 * back to local `decimals`, flooring the sub-trim remainder. This is the
 * amount the relayer sees as `flow.amount`, so the floor must be based on it.
 */
export function applyNttTrim(amount: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError(`decimals out of range: ${decimals}`)
  }
  if (decimals <= NTT_TRIMMING_DECIMALS) {
    return amount
  }
  const factor = 10n ** BigInt(decimals - NTT_TRIMMING_DECIMALS)
  return (amount / factor) * factor
}

export interface ComputeMinSwapOutParams {
  direction: 'deposit' | 'withdraw'
  /** Input in the relayer's basis — NTT post-trim (use `applyNttTrim`). */
  postTrimInAmount: bigint
  /** Raw OnRe `Offer` account bytes (the cranker/swap NAV source). */
  offerData: Uint8Array
  /** Unix seconds the price vector is evaluated at (sign-time clock). */
  nowUnix: bigint
  baseDecimals: number
  onycDecimals: number
  /** User slippage tolerance in bps `[0, 10_000]`. */
  slippageBps: number
  /**
   * Relayer withdraw fee (bps), taken from the ONyc input before the swap.
   * Withdraw only; ignored for deposit (its fee is post-floor). Default 0.
   */
  withdrawFeeBps?: number
}

/**
 * Compute the user-signed swap floor in output-token atomic units (ONyc for
 * deposit, USDC for withdraw). Reuses the OnRe NAV mirrors so the preview
 * matches the on-chain floor. Throws on a bad slippage / non-positive input,
 * or a zero computed floor (on-chain `receive` rejects min_swap_out == 0).
 */
export function computeMinSwapOut(params: ComputeMinSwapOutParams): bigint {
  const { direction, postTrimInAmount, offerData, nowUnix, baseDecimals, onycDecimals, slippageBps } = params
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`slippageBps out of [0, 10_000]: ${slippageBps}`)
  }
  if (postTrimInAmount <= 0n) {
    throw new RangeError('postTrimInAmount must be > 0')
  }

  const price = calculateStepPrice(parseActiveOfferVector(offerData, nowUnix), nowUnix)

  let expectedGross: bigint
  if (direction === 'deposit') {
    expectedGross = depositExpectedOut(postTrimInAmount, price, baseDecimals, onycDecimals)
  } else {
    // `withdrawFeeBps` MUST match the on-chain `cfg.withdraw_fee_bps`: the floor
    // is computed net-of-fee but on-chain the fee is taken from the actual input,
    // so a drift makes the floor and swap input disagree (the swap just reverts
    // — not exploitable, but a footgun). Callers pass `cfg.withdrawFeeBps`.
    const withdrawFeeBps = params.withdrawFeeBps ?? 0
    if (!Number.isInteger(withdrawFeeBps) || withdrawFeeBps < 0 || withdrawFeeBps > 10_000) {
      throw new RangeError(`withdrawFeeBps out of [0, 10_000]: ${withdrawFeeBps}`)
    }
    const fee = (postTrimInAmount * BigInt(withdrawFeeBps)) / BPS_DENOMINATOR
    const netInput = postTrimInAmount - fee
    if (netInput <= 0n) {
      throw new RangeError('withdraw fee consumes the entire input')
    }
    expectedGross = redemptionExpectedOut(netInput, price, onycDecimals, baseDecimals)
  }

  const floor = (expectedGross * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR
  if (floor <= 0n) {
    throw new RangeError(
      'computed min_swap_out is 0 (input too small or slippage too high); on-chain receive rejects a zero floor',
    )
  }
  return floor
}
