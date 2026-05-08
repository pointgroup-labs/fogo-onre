import type { PublicKey } from '@solana/web3.js'

/**
 * Shape of a `Flow` account fetched via `RelayerClient.fetchInflightFlow`
 * / `fetchOutflightFlow`. The `status` field is the Anchor enum
 * representation: exactly one variant key is present, mapped to an empty
 * object.
 */
export interface FlowAccount {
  fogoSender: number[] | Uint8Array
  status: { claimed?: object, swapped?: object, redemptionPending?: object }
  amount: { toString: () => string }
  payer: PublicKey
}

export type FlowStatusName = 'Claimed' | 'Swapped' | 'RedemptionPending' | 'Unknown'

/** Stringify the Anchor enum status into a readable label. */
export function describeStatus(status: FlowAccount['status']): FlowStatusName {
  if (status.claimed !== undefined) {
    return 'Claimed'
  }
  if (status.swapped !== undefined) {
    return 'Swapped'
  }
  if (status.redemptionPending !== undefined) {
    return 'RedemptionPending'
  }
  return 'Unknown'
}
