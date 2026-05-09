import type { PublicKey } from '@solana/web3.js'
import type { FlowKind } from '@/lib/flow-status/types'

/**
 * One row from FOGO RPC enumeration. Represents a user-initiated
 * `transfer_burn` on FOGO. Receives are not BurnRows — they're consumed
 * inside `merge.ts` only as fulfillment evidence, never as their own
 * rows.
 */
export interface BurnRow {
  signature: string
  ata: PublicKey
  mint: PublicKey
  amountRaw: bigint
  blockTime: number
  slot: number
}

/**
 * Wormholescan status oracle result for a single source tx hash.
 * `unknown` is returned on any failure mode (404, network error, parse
 * error, timeout) so the UI can render a graceful-degrade row without
 * a status badge.
 */
export type OperationStatus
  = | { kind: 'delivered', destinationTxHash: string }
    | { kind: 'pending' }
    | { kind: 'unknown' }

/**
 * Final merged shape consumed by `BridgeHistory.tsx`. One row per
 * user-initiated bridge intent, keyed on the FOGO `transfer_burn` tx
 * signature. `phase` (granular journal pill) takes display precedence
 * over `status` (basic two-state) when present and non-terminal.
 */
export interface TimelineRow {
  signature: string
  kind: FlowKind
  amountRaw: bigint
  mintB58: string
  blockTime: number
  status: OperationStatus['kind']
  destinationSignature: string | null
  /** Set only when this device + this session originated the bridge and the journal entry is still non-terminal. */
  phase: string | null
}
