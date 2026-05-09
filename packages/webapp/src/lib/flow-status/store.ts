import type { QueryClient } from '@tanstack/react-query'
import type { PersistedFlowStatus } from './types'

const FLOW_KEY = (id: string) => ['flow-status', id] as const
const INDEX_KEY = ['pending-flow-ids'] as const

export function readIndex(qc: QueryClient): string[] {
  return qc.getQueryData<string[]>(INDEX_KEY) ?? []
}

export function writeIndex(qc: QueryClient, ids: string[]) {
  qc.setQueryData<string[]>(INDEX_KEY, ids)
}

export function addFlow(qc: QueryClient, status: PersistedFlowStatus) {
  qc.setQueryData<PersistedFlowStatus>(FLOW_KEY(status.flowId), status)
  const ids = readIndex(qc)
  if (!ids.includes(status.flowId)) {
    writeIndex(qc, [...ids, status.flowId])
  }
}

export function readFlow(qc: QueryClient, id: string): PersistedFlowStatus | undefined {
  return qc.getQueryData<PersistedFlowStatus>(FLOW_KEY(id))
}

export function patchFlow(
  qc: QueryClient,
  id: string,
  patch: Partial<PersistedFlowStatus>,
) {
  const prev = readFlow(qc, id)
  if (!prev) {
    return
  }
  qc.setQueryData<PersistedFlowStatus>(FLOW_KEY(id), { ...prev, ...patch })
}

export function pendingWithdrawExists(qc: QueryClient): boolean {
  for (const id of readIndex(qc)) {
    const f = readFlow(qc, id)
    if (f && f.kind === 'withdraw' && f.status !== 'terminal-success' && f.status !== 'terminal-failure') {
      return true
    }
  }
  return false
}
