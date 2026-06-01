import type { PublicKey } from '@solana/web3.js'

/**
 * Shape of a `Flow` account fetched via `RelayerClient.fetchInflightFlow`
 * / `fetchOutflightFlow`. The `status` field is the Anchor enum
 * representation: exactly one variant key is present, mapped to an empty
 * object.
 */
export interface FlowAccount {
  recipient: number[] | Uint8Array
  status: { received?: object, swapped?: object }
  amount: { toString: () => string }
  payer: PublicKey
}

export type FlowStatusName = 'Received' | 'Swapped' | 'Unknown'

/** Stringify the Anchor enum status into a readable label. */
export function describeStatus(status: FlowAccount['status']): FlowStatusName {
  if (status.received !== undefined) {
    return 'Received'
  }
  if (status.swapped !== undefined) {
    return 'Swapped'
  }
  return 'Unknown'
}
