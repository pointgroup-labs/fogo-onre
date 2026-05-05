'use client'

import { findOnreOfferPda, ONYC_MINT } from '@fogo-onre/sdk'
import { useEffect, useState } from 'react'
import { SOLANA_USDC_MINT } from '@/constants'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { useSettings } from '@/store/settings'
import { getSolanaConnection } from '@/utils/connections'
import {
  computeOnycPriceFromVector,
  decodeOnreOfferPriceVectors,
  ONRE_PRICE_SCALE,
  selectActiveVector,
} from '@/utils/onyc-price'

/**
 * Live ONyc price snapshot fetched from the OnRe Offer account on Solana.
 *
 * `null` until the first fetch resolves. `error` is non-null when the
 * fetcher fails (account missing, malformed, RPC unreachable) so the UI
 * can fall back to a preview rate transparently rather than displaying
 * nothing.
 */
export interface OnycPriceState {
  /** Spot price in `ONRE_PRICE_SCALE` units (USDC base per ONyc base, scaled). */
  onycPrice: bigint
  /** Same scale as `onycPrice`; pinned to `ONRE_PRICE_SCALE`. */
  priceScale: bigint
  /**
   * APR of the active price vector, expressed in basis points (1 bp = 0.01%).
   * Sourced from the on-chain `apr` field which is scaled by `APR_SCALE = 1e6`
   * (so `apr = 1_000_000` = 100%); we convert via `apr / 100n` to land in bps.
   */
  aprBps: number
  /** ms-epoch the snapshot was last refreshed (for UI staleness display). */
  fetchedAt: number
}

const REFRESH_MS = 30_000

export function useOnycPrice(): { price: OnycPriceState | null, error: string | null } {
  const [price, setPrice] = useState<OnycPriceState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const visible = useDocumentVisible()
  // Subscribe so a settings change rebinds the polling loop against the
  // new endpoint immediately.
  const { solanaRpcUrl } = useSettings()

  useEffect(() => {
    let cancelled = false
    const connection = getSolanaConnection(solanaRpcUrl)
    const [offerPda] = findOnreOfferPda(SOLANA_USDC_MINT, ONYC_MINT)

    async function refresh() {
      try {
        const account = await connection.getAccountInfo(offerPda, 'confirmed')
        if (cancelled) {
          return
        }
        if (account === null) {
          setError(`OnRe offer account ${offerPda.toBase58()} not found`)
          return
        }
        const vectors = decodeOnreOfferPriceVectors(account.data)
        if (vectors.length === 0) {
          setError('OnRe offer contains no price vectors')
          return
        }
        const now = BigInt(Math.floor(Date.now() / 1000))
        const active = selectActiveVector(vectors, now)
        if (active === null) {
          setError('Could not select an active price vector')
          return
        }
        const onycPrice = computeOnycPriceFromVector(active, now)
        setPrice({
          onycPrice,
          priceScale: ONRE_PRICE_SCALE,
          aprBps: Number(active.apr / 100n),
          fetchedAt: Date.now(),
        })
        setError(null)
      } catch (err) {
        if (cancelled) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to fetch OnRe price')
      }
    }

    refresh()
    if (!visible) {
      return () => {
        cancelled = true
      }
    }
    const id = setInterval(refresh, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [visible, solanaRpcUrl])

  return { price, error }
}
