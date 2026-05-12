'use client'

import type { FlowPhase } from '@/hooks/useFlowStatus'
import type { FlowStatusValue, PersistedFlowStatus } from '@/lib/flow-status/types'
import { PublicKey } from '@solana/web3.js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useFlowStatus } from '@/hooks/useFlowStatus'
import { patchFlow } from '@/lib/flow-status/store'
import { isTerminal } from '@/lib/flow-status/types'
import { fogoTxUrl } from '@/utils/explorers'

/**
 * Headless. Renders nothing. Mounted once per page, drives every
 * non-terminal journal entry forward by running `useFlowStatus` against
 * it and writing terminal status + firing the user-visible toast on
 * completion.
 *
 * Previously this logic lived inside `PendingTxList`'s `PendingRow`,
 * which meant deleting `PendingTxList` would also stop journal
 * progression. Splitting this out lets `BridgeHistory` be a pure reader.
 */
export default function LiveJournalTracker() {
  const idsQuery = useQuery<string[]>({
    queryKey: ['pending-flow-ids'],
    queryFn: () => [],
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    initialData: [],
  })
  const ids = idsQuery.data ?? []

  return (
    <>
      {ids.map(id => <TrackerRow key={id} flowId={id} />)}
    </>
  )
}

function statusFromPhase(phase: FlowPhase | undefined): FlowStatusValue {
  if (phase === 'delivered') {
    return 'terminal-success'
  }
  if (phase === 'expired') {
    return 'terminal-failure'
  }
  if (phase === 'bridging' || phase === 'submitted') {
    return 'in-progress'
  }
  return 'pending'
}

function TrackerRow({ flowId }: { flowId: string }) {
  const qc = useQueryClient()
  const { data: persisted } = useQuery<PersistedFlowStatus | null>({
    queryKey: ['flow-status', flowId],
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const flowInput = useMemo(() => {
    if (!persisted) {
      return null
    }
    return {
      signature: persisted.signature,
      owner: new PublicKey(persisted.ownerB58),
      kind: persisted.kind,
      startedAt: persisted.startedAt,
      baselineBalance: BigInt(persisted.baselineDestBalanceStr),
    }
  }, [persisted])

  const flow = useFlowStatus(flowInput ?? {
    signature: null,
    owner: null,
    kind: persisted?.kind ?? 'deposit',
    startedAt: null,
    baselineBalance: null,
  })

  useEffect(() => {
    if (!flow || !persisted) {
      return
    }
    const liveStatus = statusFromPhase(flow.phase)
    // Promote 'pending' → 'in-progress' on first non-`'submitted'`
    // phase, so the BridgeHistory row shows "Bridging" instead of
    // staying stuck on "Submitting" until terminal. Without this, the
    // journal status only ever advances when the flow finishes,
    // which makes long withdraw chains look frozen even when the
    // cross-chain progress is healthy.
    if (
      liveStatus === 'in-progress'
      && persisted.status === 'pending'
    ) {
      patchFlow(qc, flowId, { status: 'in-progress' })
    }
    if (isTerminal(liveStatus) && !persisted.notified) {
      patchFlow(qc, flowId, { status: liveStatus, notified: true })
      const action = {
        label: 'Explore',
        onClick: () => {
          window.open(fogoTxUrl(persisted.signature), '_blank', 'noopener,noreferrer')
        },
      }
      if (liveStatus === 'terminal-success') {
        toast.success(persisted.kind === 'deposit' ? 'Deposit complete' : 'Redemption complete', { id: flowId, action })
      } else {
        toast.error('Transfer failed', { id: flowId, action })
      }
    }
  }, [flow?.phase, persisted, flowId, qc, flow])

  return null
}
