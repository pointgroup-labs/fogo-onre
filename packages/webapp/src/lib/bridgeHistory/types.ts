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
  /**
   * True when `amountRaw` is reconstructed (no journal entry exists for
   * this signature on this device), not lifted directly from the user's
   * typed input. Cross-session/device deposits hit this path; we
   * back-derive principal as `gross - bridge_transfer_fee` when the
   * on-chain fee is known. The UI prefixes `~` to signal the value is
   * approximate.
   */
  amountIsApproximate: boolean
  mintB58: string
  blockTime: number
  status: OperationStatus['kind']
  destinationSignature: string | null
  /** Set only when this device + this session originated the bridge and the journal entry is still non-terminal. */
  phase: string | null
  /**
   * True when the user has explicitly marked this row delivered via
   * the dismiss affordance. Used for legacy pre-fix rows where the
   * Wormholescan oracle cannot report `delivered` because the VAA was
   * emitted by a separate recovery tx, not the original source tx —
   * `/operations?txHash=<source>` then returns no `targetChain`. Display
   * treats this as `delivered` with an explicit "(marked)" indicator so
   * automatic vs manual resolution stay distinguishable.
   */
  manuallyDismissed: boolean
}
