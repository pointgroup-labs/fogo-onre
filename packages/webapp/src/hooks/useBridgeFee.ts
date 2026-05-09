'use client'

import { useQuery } from '@tanstack/react-query'
import { USDC_DECIMALS, USDC_S_MINT } from '@/constants'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { findFeeConfigPda, readBridgeTransferFee } from '@/lib/bridge/feeConfig'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

/**
 * Live preview of the deposit bridge fee.
 *
 * The deposit ix is built with `fee_mint = USDC.s` and routed through
 * Fogo Labs' generic `sessions` paymaster under the `Intent NTT Bridge`
 * variation — the user pays the executor's cross-chain delivery escrow
 * out of their USDC.s balance via intent_transfer's own deduction, and
 * native FOGO gas is sponsored. The user-facing figure is therefore
 * the on-chain `FeeConfig.bridge_transfer_fee` for USDC.s, not the
 * executor's FOGO-denominated baseFee.
 *
 * `FeeConfig` rarely changes on-chain, so a slow refresh cadence is
 * fine; the heavy Wormhole quote fetch the previous version did is
 * gone entirely.
 */

export interface BridgeFeePreview {
  /** Fee amount in USDC.s base units (6 decimals). `null` while loading. */
  feeRaw: bigint | null
  feeDecimals: number
  feeSymbol: string
  error: string | null
}

export function useBridgeFee(): BridgeFeePreview {
  const visible = useDocumentVisible()
  const { fogoRpcUrl } = useSettings()

  const query = useQuery({
    queryKey: ['bridge-fee', fogoRpcUrl] as const,
    staleTime: 30_000,
    refetchInterval: visible ? 60_000 : false,
    queryFn: async (): Promise<bigint> => {
      const feeConfig = findFeeConfigPda(USDC_S_MINT)
      const conn = getFogoConnection(fogoRpcUrl)
      return readBridgeTransferFee(conn, feeConfig)
    },
  })

  return {
    feeRaw: query.data ?? null,
    feeDecimals: USDC_DECIMALS,
    feeSymbol: 'USDC.s',
    error: query.error?.message ?? null,
  }
}
