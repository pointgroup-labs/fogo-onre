export type FlowStatusValue
  = | 'pending'
    | 'in-progress'
    | 'terminal-success'
    | 'terminal-failure'

export type FlowKind = 'deposit' | 'withdraw'

export interface PersistedFlowStatus {
  flowId: string
  kind: FlowKind
  signature: string
  ownerB58: string
  mintB58: string
  amountStr: string
  startedAt: number
  baselineDestBalanceStr: string
  status: FlowStatusValue
  notified: boolean
  lastPolledAt: number
}

export const TERMINAL_STATUSES: ReadonlySet<FlowStatusValue>
  = new Set(['terminal-success', 'terminal-failure'])

export function isTerminal(s: FlowStatusValue): boolean {
  return TERMINAL_STATUSES.has(s)
}
