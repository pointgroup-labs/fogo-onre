import type { AdvanceContext, AdvanceResult } from './types'

/**
 * Step 1 of the withdraw chain. Drives `unlock_onyc` on Solana:
 * NTT redeem (FOGO ONyc burn VAA) + release into the relayer's ONyc
 * inflight ATA + write the **outflight** Flow PDA.
 *
 * Counterpart of `claimUsdc` for the withdraw leg. The on-chain
 * handler lives at `programs/relayer/src/instructions/unlock_onyc.rs`
 * and parses the VAA's `ValidatedTransceiverMessage` to extract
 * `fogo_sender` (the user wallet) — that's the only stable per-user
 * correlator on the withdraw side.
 *
 * Stub: PR 2 will port the body. Until then, the daemon enumerates
 * withdraw VAAs, recognises them as `WithdrawPending`, and skips here
 * with a noop reason that surfaces in the `flow_skipped` counter
 * label so operators see exactly which leg is gated.
 */
export type UnlockOnycInput = {
  fogoTx: string
  vaaHex?: string
}

export async function unlockOnyc(
  _ctx: AdvanceContext,
  _input: UnlockOnycInput,
): Promise<AdvanceResult> {
  return {
    kind: 'noop',
    reason: 'unlockOnyc: unimplemented (stub) — see spec §4.1 / PR 2',
  }
}
