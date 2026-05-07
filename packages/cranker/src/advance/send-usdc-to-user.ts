import type { PublicKey } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './types'

export type SendUsdcToUserInput = {
  nttInboxItem: PublicKey
}

/**
 * Withdraw chain step 4: NTT `transfer_lock` USDC.s back to FOGO to the
 * original withdrawer's address; closes the outflight Flow.
 *
 * TODO(withdraw): port from programs/relayer/src/instructions/send_usdc_to_user.rs.
 * Mirrors lockOnyc structure (NTT outbound transfer with rent top-ups
 * for relayer_authority and session_authority).
 */
export async function sendUsdcToUser(
  _ctx: AdvanceContext,
  _input: SendUsdcToUserInput,
): Promise<AdvanceResult> {
  return {
    kind: 'error',
    error: new Error('sendUsdcToUser: not implemented (withdraw chain deferred)'),
    partialSignatures: [],
  }
}
