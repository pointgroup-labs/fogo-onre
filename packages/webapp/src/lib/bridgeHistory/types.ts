import type { PublicKey } from '@solana/web3.js'

/**
 * One row from FOGO RPC enumeration. Represents a user-initiated
 * `transfer_burn` on FOGO. Used only by the (currently orphaned) FOGO
 * RPC burn-paging pipeline in `rpc.ts`. The active history pipeline
 * derives actions from Wormholescan directly.
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
