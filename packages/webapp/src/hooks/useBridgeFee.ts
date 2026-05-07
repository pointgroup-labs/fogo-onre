'use client'

import { useEffect, useState } from 'react'
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

const REFRESH_MS = 60_000

export interface BridgeFeePreview {
  /** Fee amount in USDC.s base units (6 decimals). `null` while loading. */
  feeRaw: bigint | null
  feeDecimals: number
  feeSymbol: string
  error: string | null
}

export function useBridgeFee(): BridgeFeePreview {
  const [feeRaw, setFeeRaw] = useState<bigint | null>(null)
  const [error, setError] = useState<string | null>(null)
  const visible = useDocumentVisible()
  const { fogoRpcUrl } = useSettings()

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      try {
        const feeConfig = findFeeConfigPda(USDC_S_MINT)
        const conn = getFogoConnection(fogoRpcUrl)
        const fee = await readBridgeTransferFee(conn, feeConfig)
        if (cancelled) {
          return
        }
        setFeeRaw(fee)
        setError(null)
      } catch (err) {
        if (cancelled) {
          return
        }
        setError(err instanceof Error ? err.message : 'Failed to read bridge fee')
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
  }, [visible, fogoRpcUrl])

  return { feeRaw, feeDecimals: USDC_DECIMALS, feeSymbol: 'USDC.s', error }
}
