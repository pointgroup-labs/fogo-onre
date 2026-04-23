/**
 * Helpers for injecting pre-built Anchor accounts into LiteSVM via setAccount().
 *
 * Used to test instructions that consume existing PDAs (e.g. cancel_flow)
 * without needing to go through the full CPI flow that creates them.
 */

import type { LiteSVM } from 'litesvm'
import { RELAYER_PROGRAM_ID } from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'

// Anchor discriminators from the IDL
const FLOW_DISCRIMINATOR = new Uint8Array([126, 151, 86, 177, 58, 153, 167, 203])
const REDEMPTION_TRACKER_DISCRIMINATOR = new Uint8Array([1, 150, 121, 192, 138, 107, 94, 3])

/**
 * Flow status enum variants matching Anchor Borsh serialization.
 *
 * Source order pinned by `flow_status_borsh_tag_invariant` in
 * `programs/relayer/src/state.rs`: Claimed=0, Swapped=1, RedemptionPending=2
 * (appended, not inserted, so already-allocated Flow PDAs stay loadable).
 */
export const FlowStatus = {
  Claimed: 0,
  Swapped: 1,
  RedemptionPending: 2,
} as const

export interface FlowData {
  fogoSender: Uint8Array // 32 bytes
  status: number // 0=Claimed, 1=Swapped, 2=RedemptionPending
  amount: bigint
  payer: PublicKey
  bump: number
}

/**
 * Serialize a Flow account in Anchor format:
 *   discriminator(8) + fogo_sender(32) + status(1) + amount(8) + payer(32) + bump(1)
 * Total: 82 bytes
 */
export function serializeFlow(flow: FlowData): Uint8Array {
  const data = new Uint8Array(8 + 32 + 1 + 8 + 32 + 1) // 82 bytes
  const view = new DataView(data.buffer)

  let offset = 0
  // discriminator
  data.set(FLOW_DISCRIMINATOR, offset)
  offset += 8

  // fogo_sender [u8; 32]
  data.set(flow.fogoSender, offset)
  offset += 32

  // status (Borsh enum: 1 byte variant index)
  data[offset++] = flow.status

  // amount (u64 LE)
  view.setBigUint64(offset, flow.amount, true)
  offset += 8

  // payer (Pubkey, 32 bytes)
  data.set(flow.payer.toBuffer(), offset)
  offset += 32

  // bump (u8)
  data[offset] = flow.bump

  return data
}

/**
 * Inject a Flow PDA into LiteSVM, owned by the relayer program.
 */
export function setFlowAccount(
  svm: LiteSVM,
  address: PublicKey,
  flow: FlowData,
  programId: PublicKey = RELAYER_PROGRAM_ID,
): void {
  const data = serializeFlow(flow)
  svm.setAccount(address, {
    executable: false,
    owner: programId,
    lamports: 1_500_000, // enough for rent
    data,
    rentEpoch: 0,
  })
}

export interface RedemptionTrackerData {
  flow: PublicKey
  redemptionRequest: PublicKey
  usdcAtaPreBalance: bigint
  onycAmountIn: bigint
  payer: PublicKey
  bump: number
}

/**
 * Serialize a `RedemptionTracker` account in Anchor format:
 *   discriminator(8) + flow(32) + redemption_request(32)
 *     + usdc_ata_pre_balance(8) + onyc_amount_in(8) + payer(32) + bump(1)
 * Total: 121 bytes
 *
 * `claim_redemption_usdc` reads `tracker.flow`, `tracker.redemption_request`,
 * `tracker.usdc_ata_pre_balance`, `tracker.onyc_amount_in`, `tracker.bump`,
 * and `tracker.payer` (via the `close = payer_for_close` constraint pinned
 * to `address = redemption_tracker.payer`). Every field matters for at
 * least one constraint.
 */
export function serializeRedemptionTracker(t: RedemptionTrackerData): Uint8Array {
  const data = new Uint8Array(8 + 32 + 32 + 8 + 8 + 32 + 1) // 121 bytes
  const view = new DataView(data.buffer)

  let offset = 0
  data.set(REDEMPTION_TRACKER_DISCRIMINATOR, offset)
  offset += 8

  data.set(t.flow.toBuffer(), offset)
  offset += 32

  data.set(t.redemptionRequest.toBuffer(), offset)
  offset += 32

  view.setBigUint64(offset, t.usdcAtaPreBalance, true)
  offset += 8

  view.setBigUint64(offset, t.onycAmountIn, true)
  offset += 8

  data.set(t.payer.toBuffer(), offset)
  offset += 32

  data[offset] = t.bump

  return data
}

/**
 * Inject a `RedemptionTracker` PDA into LiteSVM, owned by the relayer
 * program. Substitutes for a real `request_redemption_onyc` invocation
 * when the test isn't ready to plumb the OnRe `create_redemption_request`
 * CPI (no SDK helper or fixture set for the OnRe `RedemptionRequest` PDA
 * yet).
 *
 * The amount of lamports must satisfy rent for a 121-byte account. The
 * value below is comfortably above the minimum and matches what
 * `request_redemption_onyc` would have charged via Anchor's `init`
 * constraint at runtime.
 */
export function setRedemptionTracker(
  svm: LiteSVM,
  address: PublicKey,
  tracker: RedemptionTrackerData,
  programId: PublicKey = RELAYER_PROGRAM_ID,
): void {
  const data = serializeRedemptionTracker(tracker)
  svm.setAccount(address, {
    executable: false,
    owner: programId,
    lamports: 1_900_000, // covers rent for a 121-byte account
    data,
    rentEpoch: 0,
  })
}
