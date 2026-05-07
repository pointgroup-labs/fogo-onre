'use client'

import type { OnycPriceSnapshot } from '@fogo-onre/sdk'
import { computeOnycPrice } from '@fogo-onre/sdk'
import { useEffect, useState } from 'react'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { useOnycPrice } from '@/hooks/useOnycPrice'
import { useSettings } from '@/store/settings'
import { useToastsStore } from '@/store/toasts'
import { getReadOnlyRelayerClient } from '@/utils/connections'

/**
 * Source of truth for the current `RelayerConfig` snapshot the UI quotes
 * against.
 *
 * Live data path:
 *   - `depositFeeBps` / `withdrawFeeBps`: read from on-chain
 *     `RelayerConfig` via `RelayerClient.fetchConfig()` (Solana mainnet,
 *     u16 → JS number).
 *   - `onycPrice` / `price.priceScale`: read from the OnRe Offer account
 *     (Solana mainnet) via `useOnycPrice`. Until the first fetch resolves
 *     (or if the fetch fails), `priceIsPreview` is true and the UI surfaces
 *     a placeholder rate honestly. As soon as a live vector decodes,
 *     `priceIsPreview` flips false.
 *
 * Quote functions consume `(onycPrice, price.priceScale)` only — the rest
 * of `price` (`basePrice`, `aprBps`, `startTimestamp`) is informational.
 * That lets us swap in a fully-computed live `onycPrice` without needing
 * to round OnRe's 1e6-scaled APR into the SDK's bps representation, which
 * would lose precision.
 */

export interface ProtocolState {
  depositFeeBps: number
  withdrawFeeBps: number
  price: OnycPriceSnapshot
  onycPrice: bigint
  /** True iff the price came from the placeholder, not a live OnRe read. */
  priceIsPreview: boolean
  /** Surfaces RelayerConfig fetch failure so callers can render a degraded UI. */
  feeFetchError: string | null
  /** Surfaces OnRe price fetch failure (separate from fee fetch). */
  priceFetchError: string | null
}

const PLACEHOLDER_PRICE: OnycPriceSnapshot = {
  basePrice: 1_000_000n,
  priceScale: 1_000_000_000n,
  aprBps: 0,
  startTimestamp: 0n,
}

const REFRESH_MS = 60_000

export function useProtocolState(): ProtocolState | null {
  const [now, setNow] = useState<bigint | null>(null)
  const [feeBps, setFeeBps] = useState<{ deposit: number, withdraw: number } | null>(null)
  const [feeFetchError, setFeeFetchError] = useState<string | null>(null)
  const { price: livePrice, error: priceFetchError } = useOnycPrice()
  const visible = useDocumentVisible()
  const { solanaRpcUrl } = useSettings()

  useEffect(() => {
    setNow(BigInt(Math.floor(Date.now() / 1000)))
    const id = setInterval(() => {
      setNow(BigInt(Math.floor(Date.now() / 1000)))
    }, 30_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    const client = getReadOnlyRelayerClient(solanaRpcUrl)

    async function refreshFees() {
      try {
        const config = await client.fetchConfig()
        if (cancelled) {
          return
        }
        setFeeBps({
          deposit: Number(config.depositFeeBps),
          withdraw: Number(config.withdrawFeeBps),
        })
        setFeeFetchError(null)
        // Clear the visible error toast on recovery so a transient RPC
        // hiccup doesn't leave the user staring at a stale banner.
        useToastsStore.getState().dismiss('protocol-fee-fetch-error')
      } catch (err) {
        if (cancelled) {
          return
        }
        const message = err instanceof Error ? err.message : 'Failed to fetch RelayerConfig'
        setFeeFetchError(message)
        // Surface the error explicitly. The hook itself returns `null` while
        // fees are unavailable (which blocks quoting + submission downstream),
        // so without this toast the UI would just look "stuck loading".
        useToastsStore.getState().upsert({
          id: 'protocol-fee-fetch-error',
          kind: 'error',
          title: 'Live fee fetch failed',
          description: 'Quotes are blocked until RelayerConfig is reachable. Check your Solana RPC and reload.',
        })
      }
    }

    refreshFees()
    if (!visible) {
      return () => {
        cancelled = true
      }
    }
    const id = setInterval(refreshFees, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [visible, solanaRpcUrl])

  if (now === null) {
    return null
  }

  // Live price wins when present. The SDK's snapshot type still expects
  // `basePrice`/`aprBps` fields — we satisfy them with the live `onycPrice`
  // and the live APR (in bps) so consumers like `ProtocolStats` can read
  // the rate without touching the lower-level vector decoder.
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

  // Fee-fetch failure must HARD-FAIL the quote path, not silently quote at
  // 0 bps. The previous behaviour (`feeBps === null && feeFetchError === null`)
  // let the hook return a state with `depositFeeBps: 0` whenever fees errored,
  // which would have shown the user an inflated "you receive" line during a
  // RelayerConfig outage. We block rendering the quote entirely and surface
  // the error via a toast (see `refreshFees`).
  if (feeBps === null) {
    return null
  }

  return {
    depositFeeBps: feeBps.deposit,
    withdrawFeeBps: feeBps.withdraw,
    price: priceSnapshot,
    onycPrice,
    priceIsPreview,
    feeFetchError,
    priceFetchError,
  }
}
