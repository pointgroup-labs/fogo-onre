import type { PublicKey } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './types'

export type RequestRedemptionInput = {
  nttInboxItem: PublicKey
}

/**
 * Withdraw chain step 2: OnRe `create_redemption_request` CPI burns the
 * relayer's ONyc and creates a RedemptionRequest PDA on OnRe.
 *
 * TODO(withdraw): port from programs/relayer/src/instructions/request_redemption_onyc.rs.
 */
export async function requestRedemption(
  _ctx: AdvanceContext,
  _input: RequestRedemptionInput,
): Promise<AdvanceResult> {
  return {
    kind: 'error',
    error: new Error('requestRedemption: not implemented (withdraw chain deferred)'),
    partialSignatures: [],
  }
}
