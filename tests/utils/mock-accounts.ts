/**
 * Helpers for injecting pre-built Anchor accounts into LiteSVM via setAccount().
 *
 * Used to test instructions that consume existing PDAs (e.g. cancel_flow)
 * without needing to go through the full CPI flow that creates them.
 */

import type { LiteSVM } from 'litesvm'
import { RELAYER_PROGRAM_ID } from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'

// Anchor discriminator from the IDL
const FLOW_DISCRIMINATOR = new Uint8Array([126, 151, 86, 177, 58, 153, 167, 203])

/**
 * Flow status enum variants matching Anchor Borsh serialization.
 *
 * Source order pinned by `flow_status_borsh_tag_invariant` in
 * `programs/relayer/src/state.rs`: Received=0, Swapped=1.
 */
export const FlowStatus = {
  Received: 0,
  Swapped: 1,
} as const

export interface FlowData {
  recipient: Uint8Array // 32 bytes
  status: number // 0=Received, 1=Swapped
  amount: bigint
  payer: PublicKey
  bump: number
}

/**
 * Serialize a Flow account in Anchor format:
 *   discriminator(8) + recipient(32) + status(1) + amount(8) + payer(32) + bump(1)
 * Total: 82 bytes
 */
export function serializeFlow(flow: FlowData): Uint8Array {
  const data = new Uint8Array(8 + 32 + 1 + 8 + 32 + 1) // 82 bytes
  const view = new DataView(data.buffer)

  let offset = 0
  data.set(FLOW_DISCRIMINATOR, offset)
  offset += 8

  data.set(flow.recipient, offset)
  offset += 32

  data[offset++] = flow.status

  view.setBigUint64(offset, flow.amount, true)
  offset += 8

  data.set(flow.payer.toBuffer(), offset)
  offset += 32

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
