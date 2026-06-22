'use client'

import { useQuery } from '@tanstack/react-query'
import { FOGO_ONYC_MINT } from '@/constants'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

/**
 * Total ONyc supply on FOGO, in raw base units (×10^FOGO_ONYC_DECIMALS).
 *
 * In a vault-less protocol model — which is where we are until the FOGO
 * vault program ships — every ONyc on FOGO was minted by the relayer
 * against a user's USDC.s deposit. The mint's total supply is therefore
 * the protocol's locked principal expressed in ONyc base units; multiplied
 * by the live NAV (USDC per ONyc) it yields TVL in USDC.
 *
 * Returns `null` while the first fetch is in flight or if the RPC errors —
 * the caller (ProtocolStats) renders "—" rather than a misleading zero.
 *
 * Why a non-suspense query: the ProtocolStats card uses Suspense for the
 * PairConfig fetch, but layering a second suspense boundary on top of
 * a slower FOGO RPC would freeze the whole strip until TVL resolved.
 * Falling through to "—" lets APY/NAV render at the same time and TVL
 * pop in when ready.
 */
export function useFogoOnycSupply(): bigint | null {
  const { fogoRpcUrl } = useSettings()
  const visible = useDocumentVisible()

  const { data } = useQuery({
    queryKey: ['fogo-onyc-supply', fogoRpcUrl] as const,
    // 60s cadence. Mint supply changes only on deposit/withdraw, so a
    // tight poll would burn FOGO RPC budget for no UX benefit; a minute
    // is fast enough that the number tracks the user's own freshly-
    // landed deposit before they notice.
    staleTime: 30_000,
    refetchInterval: visible ? 60_000 : false,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const conn = getFogoConnection(fogoRpcUrl)
      const result = await conn.getTokenSupply(FOGO_ONYC_MINT)
      // `amount` is the string base-unit form; `BigInt(...)` parses
      // u64 without precision loss. `value.uiAmountString` is also
      // available but is the human-decimal form which we'd have to
      // re-multiply back up, so the raw string is cheaper.
      return BigInt(result.value.amount)
    },
  })
  return data ?? null
}
