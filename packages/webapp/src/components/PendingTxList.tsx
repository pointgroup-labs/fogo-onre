'use client'

import type { FlowStatus } from '@/hooks/useFlowStatus'
import type { FlowStatusValue, PersistedFlowStatus } from '@/lib/flow-status/types'
import { PublicKey } from '@solana/web3.js'
import { useIsRestoring, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import BridgeSteps from '@/components/BridgeSteps'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useFlowStatus } from '@/hooks/useFlowStatus'
import { patchFlow } from '@/lib/flow-status/store'
import { isTerminal } from '@/lib/flow-status/types'
import { fogoTxUrl } from '@/utils/explorers'

export default function PendingTxList() {
  const restoring = useIsRestoring()
  const idsQuery = useQuery<string[]>({
    queryKey: ['pending-flow-ids'],
    queryFn: async () => [],
    staleTime: Infinity,
  })
  const ids = idsQuery.data ?? []

  if (restoring) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    )
  }

  if (ids.length === 0) {
    return (
      <Alert>
        <AlertTitle>No recent transactions</AlertTitle>
        <AlertDescription>Your in-flight bridge transfers will appear here.</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {ids.map(id => <PendingRow key={id} flowId={id} />)}
    </div>
  )
}

function statusFromPhase(phase: FlowStatus['phase'] | undefined): FlowStatusValue {
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

function PendingRow({ flowId }: { flowId: string }) {
  const qc = useQueryClient()
  // Subscribe via useQuery so external addFlow/patchFlow writes to the same
  // cache key trigger a row re-render. The queryFn never runs (enabled: false).
  const { data: persisted } = useQuery<PersistedFlowStatus | null>({
    queryKey: ['flow-status', flowId],
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
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
    if (isTerminal(liveStatus) && !persisted.notified) {
      patchFlow(qc, flowId, { status: liveStatus, notified: true })
      if (liveStatus === 'terminal-success') {
        toast.success(persisted.kind === 'deposit' ? 'Deposit complete' : 'Withdraw complete', { id: flowId })
      } else {
        toast.error('Transfer failed', { id: flowId })
      }
    }
  }, [flow?.phase, persisted, flowId, qc, flow])

  if (!persisted) {
    return null
  }

  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {persisted.kind === 'deposit' ? 'Deposit' : 'Withdraw'}
            {' '}
            {persisted.amountStr}
          </span>
          <Badge variant={badgeVariant(persisted.status)}>{labelFor(persisted.status)}</Badge>
        </div>
        <BridgeSteps kind={persisted.kind} status={persisted.status} />
        <a
          className="text-xs text-muted-foreground hover:underline"
          href={fogoTxUrl(persisted.signature)}
          target="_blank"
          rel="noreferrer"
        >
          View on explorer
        </a>
      </CardContent>
    </Card>
  )
}

function badgeVariant(s: FlowStatusValue): 'default' | 'secondary' | 'destructive' {
  if (s === 'terminal-success') {
    return 'default'
  }
  if (s === 'terminal-failure') {
    return 'destructive'
  }
  return 'secondary'
}

function labelFor(s: FlowStatusValue): string {
  if (s === 'pending') {
    return 'Pending'
  }
  if (s === 'in-progress') {
    return 'In progress'
  }
  if (s === 'terminal-success') {
    return 'Complete'
  }
  return 'Failed'
}
