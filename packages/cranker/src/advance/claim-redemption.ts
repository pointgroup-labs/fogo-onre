import type { PublicKey } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './types'

export type ClaimRedemptionInput = {
  nttInboxItem: PublicKey
  redemptionRequest: PublicKey
}

/**
 * Withdraw chain step 3: OnRe `claim_redemption` CPI returns the USDC for
 * the burned ONyc into the relayer's USDC ATA. Advances Flow to Swapped.
 *
 * TODO(withdraw): port from programs/relayer/src/instructions/claim_redemption_usdc.rs.
 */
export async function claimRedemption(
  _ctx: AdvanceContext,
  _input: ClaimRedemptionInput,
): Promise<AdvanceResult> {
  return {
    kind: 'error',
    error: new Error('claimRedemption: not implemented (withdraw chain deferred)'),
    partialSignatures: [],
  }
}
