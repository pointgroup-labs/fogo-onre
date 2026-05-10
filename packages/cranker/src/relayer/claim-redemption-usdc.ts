import type { AdvanceContext, AdvanceResult } from './types'

/**
 * Step 3 of the withdraw chain. Drives `claim_redemption_usdc` on
 * Solana — pure on-chain bookkeeping with **no CPI**. Verifies the
 * OnRe redemption_request account is closed (lamports==0, data empty,
 * owner==system_program), computes the USDC delta vs the pre-balance
 * snapshot stored in the tracker, then closes the tracker (rent →
 * tracker.payer) and flips the outflight Flow status to `Swapped`.
 *
 * The pre-flight here is unusual: the cranker's job is to wait for
 * OnRe to fulfill the redemption off-chain (which closes the request
 * account) and then call this. While the request account is still
 * open we noop with a clear reason so operators see "waiting on OnRe"
 * rather than a generic dispatch skip.
 *
 * Stub: PR 4 will port the body.
 */
export type ClaimRedemptionUsdcInput = {
  fogoTx: string
  vaaHex?: string
}

export async function claimRedemptionUsdc(
  _ctx: AdvanceContext,
  _input: ClaimRedemptionUsdcInput,
): Promise<AdvanceResult> {
  return {
    kind: 'noop',
    reason: 'claimRedemptionUsdc: unimplemented (stub) — see spec §4.3 / PR 4',
  }
}
