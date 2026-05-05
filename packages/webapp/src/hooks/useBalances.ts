'use client'

import type { SessionState } from '@fogo/sessions-sdk-react'
import { isEstablished } from '@fogo/sessions-sdk-react'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BONYC_MINT, USDC_S_MINT } from '@/constants'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

/**
 * Polled balance snapshot for the user's USDC.s and bONyc on FOGO.
 *
 * Fields are `null` until the first fetch resolves; absent ATAs (user
 * has never received the token) report `0n`, not `null` — that maps to
 * "balance known to be empty" and lets the UI gate Submit cleanly.
 */
export interface BalanceSnapshot {
  usdc: bigint | null
  bonyc: bigint | null
}

const REFRESH_MS = 15_000

async function fetchTokenBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  try {
    const result = await connection.getTokenAccountBalance(ata, 'confirmed')
    return BigInt(result.value.amount)
  } catch {
    return 0n
  }
}

export interface UseBalancesResult {
  snapshot: BalanceSnapshot
  /**
   * Force an immediate refetch — call after a successful tx so the UI
   * doesn't show stale numbers for up to `REFRESH_MS` while the next poll
   * tick fires.
   */
  refresh: () => void
}

export function useBalances(sessionState: SessionState): UseBalancesResult {
  const owner = isEstablished(sessionState) ? sessionState.walletPublicKey : null
  const ownerKey = owner?.toBase58() ?? null
  const [snapshot, setSnapshot] = useState<BalanceSnapshot>({ usdc: null, bonyc: null })
  const visible = useDocumentVisible()
  // Subscribe to the resolved RPC URL so a settings change re-runs the
  // effect against the new endpoint immediately.
  const { fogoRpcUrl } = useSettings()
  const [refreshTick, setRefreshTick] = useState(0)
  const refresh = useCallback(() => setRefreshTick(t => t + 1), [])

  // Keep the latest fetch alive in a ref so a manual refresh can run even
  // while the interval is paused (e.g. a tx submitted while the tab is
  // backgrounded — we still want the post-success refetch to fire).
  const refetchRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    if (ownerKey === null) {
      setSnapshot({ usdc: null, bonyc: null })
      refetchRef.current = null
      return
    }

    let cancelled = false
    const ownerPk = new PublicKey(ownerKey)
    const connection = getFogoConnection(fogoRpcUrl)
    const usdcAta = getAssociatedTokenAddressSync(USDC_S_MINT, ownerPk)
    const bonycAta = getAssociatedTokenAddressSync(BONYC_MINT, ownerPk)

    const refetch = async () => {
      const [usdc, bonyc] = await Promise.all([
        fetchTokenBalance(connection, usdcAta),
        fetchTokenBalance(connection, bonycAta),
      ])
      if (!cancelled) {
        setSnapshot({ usdc, bonyc })
      }
    }
    refetchRef.current = refetch

    refetch()
    if (!visible) {
      return () => {
        cancelled = true
      }
    }
    const id = setInterval(refetch, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [ownerKey, visible, refreshTick, fogoRpcUrl])

  return { snapshot, refresh }
}
