'use client'

import type { FogoDeliveryReceipt } from '@/lib/bridgeDelivery/fogoReceipt'
import { PublicKey } from '@solana/web3.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { destinationAtaForKind, fetchFogoDeliveryReceipt } from '@/lib/bridgeDelivery/fogoReceipt'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

/**
 * Journal-free deterministic delivery oracle for the FOGO-side return-leg
 * mint. Complements `useFlowStatus` (which needs a journal + baseline);
 * this hook works on any device/session that knows the source signature,
 * blockTime, kind, and owner — i.e. anyone who can render the tx-detail
 * page from the URL alone.
 *
 * **Why both hooks exist:** `useFlowStatus` is faster (one balance read
 * per poll vs. one signatures-list + one parsed-tx fetch here) and
 * works while the FOGO RPC is still indexing the receipt. This one is
 * more robust (no baseline required) and produces an actual receipt
 * signature we can render. The Timeline ORs both signals; whichever
 * resolves first wins.
 */

const POLL_MS = 30_000

export interface FogoDeliveryInput {
  ownerB58: string | null
  kind: 'deposit' | 'withdraw'
  /** Source FOGO burn tx — used only to scope the cache key; not queried. */
  sourceSignature: string | null
  /** Block time (unix seconds) of the source burn. Anything older is filtered out. */
  sourceBlockTime: number | null
}

function isTerminal(receipt: FogoDeliveryReceipt | undefined): boolean {
  return receipt?.kind === 'delivered'
}

export function useFogoDelivery(input: FogoDeliveryInput): FogoDeliveryReceipt | null {
  const { ownerB58, kind, sourceSignature, sourceBlockTime } = input
  const { fogoRpcUrl } = useSettings()
  const visible = useDocumentVisible()
  const queryClient = useQueryClient()

  const enabled = ownerB58 !== null
    && sourceSignature !== null
    && sourceBlockTime !== null
    && sourceBlockTime > 0

  const queryKey = useMemo(
    () => ['fogo-delivery', sourceSignature, kind, ownerB58, fogoRpcUrl] as const,
    [sourceSignature, kind, ownerB58, fogoRpcUrl],
  )

  const query = useQuery<FogoDeliveryReceipt>({
    queryKey,
    enabled,
    refetchOnWindowFocus: false,
    refetchInterval: (q) => {
      if (isTerminal(q.state.data)) {
        return false
      }
      return visible ? POLL_MS : false
    },
    staleTime: q => (isTerminal(q.state.data) ? Infinity : POLL_MS),
    queryFn: async () => {
      const connection = getFogoConnection(fogoRpcUrl)
      const owner = new PublicKey(ownerB58 as string)
      return fetchFogoDeliveryReceipt(connection, {
        owner,
        kind,
        sourceBlockTime: sourceBlockTime as number,
      })
    },
  })

  // Push channel: WebSocket on the destination ATA. The same rationale
  // as `useFlowStatus` — the validator notifies within ~1 slot of the
  // mint landing, dramatically faster than the 30s poll fallback. We
  // *invalidate* rather than decode inline so the receipt-extraction
  // logic stays single-sourced inside `fetchFogoDeliveryReceipt`.
  useEffect(() => {
    if (!enabled || ownerB58 === null) {
      return
    }
    if (isTerminal(query.data)) {
      return
    }
    const connection = getFogoConnection(fogoRpcUrl)
    const owner = new PublicKey(ownerB58)
    const { ata } = destinationAtaForKind(owner, kind)
    const subId = connection.onAccountChange(
      ata,
      () => {
        queryClient.invalidateQueries({ queryKey })
      },
      'confirmed',
    )
    return () => {
      void connection.removeAccountChangeListener(subId).catch(() => {})
    }
  }, [enabled, ownerB58, kind, fogoRpcUrl, queryKey, queryClient, query.data])

  return query.data ?? null
}
