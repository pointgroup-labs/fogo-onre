'use client'

import { findOnreOfferPda, ONYC_MINT } from '@fogo-onre/sdk'
import { useQuery } from '@tanstack/react-query'
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

export function useOnycPrice(): { price: OnycPriceState | null, error: string | null } {
  const visible = useDocumentVisible()
  const { solanaRpcUrl } = useSettings()

  const query = useQuery({
    queryKey: ['onyc-price', solanaRpcUrl] as const,
    staleTime: 60_000,
    refetchInterval: visible ? 5 * 60_000 : false,
    queryFn: async (): Promise<OnycPriceState> => {
      const connection = getSolanaConnection(solanaRpcUrl)
      const [offerPda] = findOnreOfferPda(SOLANA_USDC_MINT, ONYC_MINT)
      const account = await connection.getAccountInfo(offerPda, 'confirmed')
      if (account === null) {
        throw new Error(`OnRe offer account ${offerPda.toBase58()} not found`)
      }
      const vectors = decodeOnreOfferPriceVectors(account.data)
      if (vectors.length === 0) {
        throw new Error('OnRe offer contains no price vectors')
      }
      const now = BigInt(Math.floor(Date.now() / 1000))
      const active = selectActiveVector(vectors, now)
      if (active === null) {
        throw new Error('Could not select an active price vector')
      }
      const onycPrice = computeOnycPriceFromVector(active, now)
      return {
        onycPrice,
        priceScale: ONRE_PRICE_SCALE,
        aprBps: Number(active.apr / 100n),
        fetchedAt: Date.now(),
      }
    },
  })

  const error = query.error
    ? (query.error instanceof Error ? query.error.message : 'Failed to fetch OnRe price')
    : null

  return { price: query.data ?? null, error }
}
