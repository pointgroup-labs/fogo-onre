'use client'

import type { OnycPriceSnapshot } from '@fogo-onre/sdk'
import { computeOnycPrice } from '@fogo-onre/sdk'
import { useSuspenseQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { useOnycPrice } from '@/hooks/useOnycPrice'
import { useSettings } from '@/store/settings'
import { getReadOnlyRelayerClient } from '@/utils/connections'

/**
 * Source of truth for the current `PairConfig` snapshot the UI quotes
 * against.
 *
 * Live data path:
 *   - `depositFeeBps` / `withdrawFeeBps`: read from on-chain
 *     `PairConfig` via `RelayerClient.fetchConfig()` (Solana mainnet,
 *     u16 → JS number). Fetched via `useSuspenseQuery`; failure bubbles
 *     to the nearest `<ErrorBoundary>` rather than living as a state field.
 *   - `onycPrice` / `price.priceScale`: read from the OnRe Offer account
 *     (Solana mainnet) via `useOnycPrice` (non-suspense). Until the first
 *     fetch resolves (or if the fetch fails), `priceIsPreview` is true and
 *     the UI surfaces a placeholder rate honestly.
 */

export interface ProtocolState {
  depositFeeBps: number
  withdrawFeeBps: number
  price: OnycPriceSnapshot
  onycPrice: bigint
  /** True iff the price came from the placeholder, not a live OnRe read. */
  priceIsPreview: boolean
  /** Surfaces OnRe price fetch failure (separate from fee fetch). */
  priceFetchError: string | null
}

const PLACEHOLDER_PRICE: OnycPriceSnapshot = {
  basePrice: 1_000_000n,
  priceScale: 1_000_000_000n,
  aprBps: 0,
  startTimestamp: 0n,
}

export function useProtocolState(): ProtocolState {
  const [now, setNow] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)))
  const { price: livePrice, error: priceFetchError } = useOnycPrice()
  const visible = useDocumentVisible()
  const { solanaRpcUrl } = useSettings()

  useEffect(() => {
    const id = setInterval(() => {
      setNow(BigInt(Math.floor(Date.now() / 1000)))
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  const { data: feeBps } = useSuspenseQuery({
    queryKey: ['protocol-state', solanaRpcUrl] as const,
    staleTime: 30_000,
    refetchInterval: visible ? 60_000 : false,
    queryFn: async () => {
      const client = getReadOnlyRelayerClient(solanaRpcUrl)
      const config = await client.fetchConfig()
      return {
        deposit: Number(config.depositFeeBps),
        withdraw: Number(config.withdrawFeeBps),
      }
    },
  })

  const priceIsPreview = livePrice === null
  const priceSnapshot: OnycPriceSnapshot = livePrice
    ? {
        basePrice: livePrice.onycPrice,
        priceScale: livePrice.priceScale,
        aprBps: livePrice.aprBps,
        startTimestamp: now,
      }
    : PLACEHOLDER_PRICE
  const onycPrice = livePrice
    ? livePrice.onycPrice
    : computeOnycPrice(PLACEHOLDER_PRICE, now)

  return {
    depositFeeBps: feeBps.deposit,
    withdrawFeeBps: feeBps.withdraw,
    price: priceSnapshot,
    onycPrice,
    priceIsPreview,
    priceFetchError,
  }
}
