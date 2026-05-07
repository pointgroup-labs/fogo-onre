import type { PublicKey } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './types'

export type UnlockOnycInput = {
  fogoTx: string
  vaaHex?: string
  onycMint?: PublicKey
  nttProgram?: PublicKey
}

/**
 * Withdraw chain step 1: NTT redeem ONyc on Solana, write outflight Flow
 * with status=Claimed.
 *
 * TODO(withdraw): port from programs/relayer/src/instructions/unlock_onyc.rs
 * once the FOGO ONyc NTT manager is published. Mirrors lockOnyc structure
 * but on the redeem side. See CLAUDE.md note "Withdraw-leg commands ...
 * are still deferred — they mirror the deposit pattern but on the
 * ONyc-redeem side and only matter once a user actually withdraws."
 */
export async function unlockOnyc(
  _ctx: AdvanceContext,
  _input: UnlockOnycInput,
): Promise<AdvanceResult> {
  return {
    kind: 'error',
    error: new Error('unlockOnyc: not implemented (withdraw chain deferred)'),
    partialSignatures: [],
  }
}
