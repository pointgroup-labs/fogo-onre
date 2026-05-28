'use client'

import { useQuery } from '@tanstack/react-query'
import { fetchDepositUsdcAmount } from '@/lib/bridgeHistory/depositUsdcAmount'
import { useSettings } from '@/store/settings'
import { getSolanaConnection } from '@/utils/connections'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Lazily recover the exact USDC a user deposited for an orphan deposit-
 * delivery row, keyed on the Solana `lock_onyc` sig. The walk is ~3
 * Solana RPC calls, so it runs only on the tx-detail page for the single
 * opened deposit — never eagerly across the whole history list, which
 * would multiply the cost by the number of orphan rows.
 *
 * Same `['deposit-usdc-amount', rpc, sig]` key, queryFn, and options the
 * list path used, so the persisted cache stays compatible: the value is
 * immutable on-chain (`staleTime: Infinity`), and `retry: false` because
 * `fetchDepositUsdcAmount` already handles 429 backoff internally.
 */
export function useDepositUsdcAmount(lockOnycSig: string | null): bigint | null {
  const { solanaRpcUrl } = useSettings()
  const { data } = useQuery<string | null>({
    queryKey: ['deposit-usdc-amount', solanaRpcUrl, lockOnycSig],
    enabled: lockOnycSig !== null,
    queryFn: async () => {
      const conn = getSolanaConnection(solanaRpcUrl)
      const amount = await fetchDepositUsdcAmount({ connection: conn }, lockOnycSig as string)
      return amount === null ? null : amount.toString()
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: THIRTY_DAYS_MS,
    retry: false,
  })
  return data != null ? BigInt(data) : null
}
