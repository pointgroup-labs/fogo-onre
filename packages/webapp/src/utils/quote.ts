'use client'

import type { DepositQuote, OnycPriceSnapshot, WithdrawQuote } from '@fogo-onre/sdk'
import { quoteDeposit, quoteWithdraw } from '@fogo-onre/sdk'

/**
 * Convenience wrappers around `quoteDeposit` / `quoteWithdraw` that catch the
 * SDK's RangeErrors (zero amount, fee bps out of range, zero price) and return
 * `null` so UIs can render "—" without try/catch noise at every call site.
 */

export function safeQuoteDeposit(params: {
  inputUsdc: bigint
  depositFeeBps: number
  price: OnycPriceSnapshot
  onycPrice: bigint
}): DepositQuote | null {
  try {
    return quoteDeposit({
      inputUsdc: params.inputUsdc,
      depositFeeBps: params.depositFeeBps,
      onycPrice: params.onycPrice,
      priceScale: params.price.priceScale,
    })
  } catch {
    return null
  }
}

export function safeQuoteWithdraw(params: {
  inputBonyc: bigint
  withdrawFeeBps: number
  price: OnycPriceSnapshot
  onycPrice: bigint
}): WithdrawQuote | null {
  try {
    return quoteWithdraw({
      inputBonyc: params.inputBonyc,
      withdrawFeeBps: params.withdrawFeeBps,
      onycPrice: params.onycPrice,
      priceScale: params.price.priceScale,
    })
  } catch {
    return null
  }
}
