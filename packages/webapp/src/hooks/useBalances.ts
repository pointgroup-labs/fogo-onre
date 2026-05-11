'use client'

import type { SessionState } from '@fogo/sessions-sdk-react'
import { isEstablished } from '@fogo/sessions-sdk-react'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect } from 'react'
import { FOGO_ONYC_MINT, USDC_S_MINT } from '@/constants'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

/**
 * Polled balance snapshot for the user's USDC.s and ONyc on FOGO.
 *
 * Fields are `null` until the first fetch resolves; absent ATAs (user
 * has never received the token) report `0n`, not `null` — that maps to
 * "balance known to be empty" and lets the UI gate Submit cleanly.
 */
export interface BalanceSnapshot {
  usdc: bigint | null
  fogoOnyc: bigint | null
}

const EMPTY_SNAPSHOT: BalanceSnapshot = { usdc: null, fogoOnyc: null }

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
   * doesn't show stale numbers for up to the poll interval while the next
   * tick fires.
   */
  refresh: () => void
}

export function useBalances(sessionState: SessionState): UseBalancesResult {
  const owner = isEstablished(sessionState) ? sessionState.walletPublicKey : null
  const ownerKey = owner?.toBase58() ?? null
  const visible = useDocumentVisible()
  const { fogoRpcUrl } = useSettings()

  const query = useQuery({
    queryKey: ['balances', ownerKey, fogoRpcUrl] as const,
    enabled: ownerKey !== null,
    staleTime: 10_000,
    // Poll acts as a safety net for missed WebSocket events (drops,
    // first-time-receiver ATA creation, RPC-impl quirks). The push path
    // below is the primary update mechanism — sub-second latency on
    // delivery. 60s is generous because we expect WS to do the real work.
    refetchInterval: visible ? 60_000 : false,
    queryFn: async (): Promise<BalanceSnapshot> => {
      if (ownerKey === null) {
        return EMPTY_SNAPSHOT
      }
      const ownerPk = new PublicKey(ownerKey)
      const connection = getFogoConnection(fogoRpcUrl)
      const usdcAta = getAssociatedTokenAddressSync(USDC_S_MINT, ownerPk)
      const fogoOnycAta = getAssociatedTokenAddressSync(FOGO_ONYC_MINT, ownerPk)
      const [usdc, fogoOnyc] = await Promise.all([
        fetchTokenBalance(connection, usdcAta),
        fetchTokenBalance(connection, fogoOnycAta),
      ])
      return { usdc, fogoOnyc }
    },
  })

  const refetch = query.refetch
  const refresh = useCallback(() => {
    void refetch()
  }, [refetch])

  // Push-based refresh via `onAccountChange`. Sub-second latency on
  // inbound deliveries (Wormhole NTT mint, direct transfer, etc.) without
  // hammering the RPC with polls.
  //
  // Design notes:
  // - We don't decode AccountInfo here; we just trigger `refetch()` so
  //   the existing `getTokenAccountBalance` path stays the single source
  //   of truth. Forking parse logic would risk divergent numbers across
  //   call sites.
  // - Gated on `visible`: WS subs cost the RPC provider even when no
  //   event fires, and a hidden tab can't show the new number anyway.
  // - Effect re-runs on owner/URL change → old subscriptions are torn
  //   down via `removeAccountChangeListener` in cleanup before the new
  //   pair subscribes. Avoids leaking subs across wallet switches.
  // - `refetch` from React Query is referentially stable per query
  //   lifecycle, so it doesn't cause re-subscription churn.
  useEffect(() => {
    if (ownerKey === null || !visible) {
      return
    }
    const ownerPk = new PublicKey(ownerKey)
    const connection = getFogoConnection(fogoRpcUrl)
    const usdcAta = getAssociatedTokenAddressSync(USDC_S_MINT, ownerPk)
    const fogoOnycAta = getAssociatedTokenAddressSync(FOGO_ONYC_MINT, ownerPk)
    const onChange = (): void => {
      void refetch()
    }
    const usdcSub = connection.onAccountChange(usdcAta, onChange, 'confirmed')
    const onycSub = connection.onAccountChange(fogoOnycAta, onChange, 'confirmed')
    return () => {
      void connection.removeAccountChangeListener(usdcSub)
      void connection.removeAccountChangeListener(onycSub)
    }
  }, [ownerKey, fogoRpcUrl, visible, refetch])

  return {
    snapshot: query.data ?? EMPTY_SNAPSHOT,
    refresh,
  }
}
