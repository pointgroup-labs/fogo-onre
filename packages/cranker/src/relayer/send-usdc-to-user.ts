import type { AdvanceContext, AdvanceResult } from './types'

/**
 * Step 4 (terminal) of the withdraw chain. Drives `send_usdc_to_user`
 * on Solana: builds the NTT lock-back-to-FOGO `transfer_lock` for the
 * user's recovered USDC, derives the session_authority via
 * NTT_USDC_PROGRAM_ID, calls the relayer's
 * `approve_ntt_session_authority` + `invoke_relayer_signed`, and
 * closes the outflight Flow PDA (rent → flow.payer).
 *
 * On-chain pre-flight requires `redemption_tracker` to be a
 * `SystemAccount<'info>` (i.e. closed) — which the prior
 * `claim_redemption_usdc` did. The handler must therefore confirm
 * tracker closure before dispatch; if the tracker is still open this
 * VAA is not yet ready and we noop.
 *
 * Stub: PR 5 will port the body.
 */
export type SendUsdcToUserInput = {
  fogoTx: string
  vaaHex?: string
}

export async function sendUsdcToUser(
  _ctx: AdvanceContext,
  _input: SendUsdcToUserInput,
): Promise<AdvanceResult> {
  return {
    kind: 'noop',
    reason: 'sendUsdcToUser: unimplemented (stub) — see spec §4.4 / PR 5',
  }
}
