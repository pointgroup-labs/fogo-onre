import type { AdvanceContext, AdvanceResult } from './types'

/**
 * Step 2 of the withdraw chain. Drives `request_redemption_onyc` on
 * Solana: applies the withdraw fee, transfers it to the fee_vault,
 * snapshots the relayer USDC ATA pre-balance, CPIs OnRe
 * `create_redemption_request`, and inits the singleton
 * `RedemptionTracker` PDA.
 *
 * Globally serialized: only one outflight Flow may hold the tracker at
 * a time (see `programs/relayer/src/state.rs:RedemptionTracker`). The
 * daemon's per-flow FSM gate already prevents concurrent dispatch on
 * the *same* flow, but this handler must additionally tolerate a
 * `noop` from the on-chain pre-flight when another flow holds the
 * tracker — the chain is the source of truth, not the cranker.
 *
 * Stub: PR 3 will port the body.
 */
export type RequestRedemptionOnycInput = {
  fogoTx: string
  vaaHex?: string
}

export async function requestRedemptionOnyc(
  _ctx: AdvanceContext,
  _input: RequestRedemptionOnycInput,
): Promise<AdvanceResult> {
  return {
    kind: 'noop',
    reason: 'requestRedemptionOnyc: unimplemented (stub) — see spec §4.2 / PR 3',
  }
}
