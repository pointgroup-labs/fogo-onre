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

/**
 * Past this point, an unresolved withdraw journal is treated as no
 * longer in-flight. Mirrors the `UNCONFIRMED_AFTER_MS` heuristic in
 * `BridgeHistory.tsx` — the lazy flow-status resolution sometimes
 * never patches a successfully-delivered withdraw from `'pending'` to
 * `'terminal-success'`, which used to permanently block any new
 * redeem with "Withdraw already in flight".
 *
 * The intent of this guard is to prevent *concurrent* in-flight
 * withdraws (the on-chain `RedemptionTracker` PDA is a singleton
 * mutex on the relayer side), not to block redeems for hours after
 * the previous one already settled. 2 hours is well past the
 * happy-path SLA (~10 min for a redeem) yet still long enough that
 * an actually stuck one is a "go look at the detail page" event,
 * not a "let's silently submit a second one" event.
 */
const STUCK_WITHDRAW_AGE_MS = 2 * 60 * 60_000

export function pendingWithdrawExists(qc: QueryClient): boolean {
  const now = Date.now()
  for (const id of readIndex(qc)) {
    const f = readFlow(qc, id)
    if (!f || f.kind !== 'withdraw') {
      continue
    }
    if (f.status === 'terminal-success' || f.status === 'terminal-failure') {
      continue
    }
    // Age-based escape hatch: a journal stuck on `pending` past the
    // SLA window almost certainly reflects a missed status patch, not
    // an actual in-flight redeem. Don't let it block new submissions.
    if (now - f.startedAt > STUCK_WITHDRAW_AGE_MS) {
      continue
    }
    return true
  }
  return false
}
