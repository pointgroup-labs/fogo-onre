/**
 * Variant of `withdraw-flow-e2e.test.ts` that pre-patches the synthesized
 * RedemptionOffer's `request_counter` to a non-zero value (42) before
 * calling `request_redemption_onyc`. Proves:
 *
 *   - SDK's `findOnreRedemptionRequestPda` derivation handles arbitrary
 *     counters (the seed is `[..., counter_le_u64]`).
 *   - OnRe's `init` seeds constraint inside `create_redemption_request`
 *     accepts the non-zero PDA and increments the counter to 43.
 *   - The relayer binds `tracker.redemption_request` to the PDA OnRe
 *     actually consumed (the counter=42 derivation, not counter=0).
 */

import type { WithdrawRig } from './utils'
import {
  findOnreRedemptionRequestPda,
  findRedemptionTrackerPda,
} from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FlowStatus,
  pinBinaryFixtures,
  runUnlockOnycLeg1,
  setupWithdrawRig,
  synthesizeOnreRedemptionOffer,
  WITHDRAW_TEST_CONSTANTS,

} from './utils'

// Offset of `request_counter` (u64 LE) inside RedemptionOffer.
const REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET = 138

describe('withdraw flow with non-zero request_counter', () => {
  let rig: WithdrawRig
  const { NET_ONYC_TO_ONRE, USDC_PRE_BALANCE } = WITHDRAW_TEST_CONSTANTS

  beforeEach(() => pinBinaryFixtures())
  beforeEach(async () => {
    rig = await setupWithdrawRig()
  })

  it('binds tracker to the counter=42 derivation and increments to 43', async () => {
    const { svm, authority, client, usdcMint, onycMint, usdcAta } = rig

    const { inboxItemPda, outflightPda } = await runUnlockOnycLeg1(rig)

    const { redemptionOffer } = synthesizeOnreRedemptionOffer(
      svm, onycMint.publicKey, usdcMint.publicKey,
    )

    {
      const acct = svm.getAccount(redemptionOffer)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer, data.byteOffset)
        .setBigUint64(REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET, 42n, true)
      svm.setAccount(redemptionOffer, { ...acct, data })
    }

    const [redemptionRequestPda] = findOnreRedemptionRequestPda(redemptionOffer, 42n)
    const [redemptionTrackerPda] = findRedemptionTrackerPda(client.program.programId)

    {
      const ataAcct = svm.getAccount(usdcAta)!
      const ataData = new Uint8Array(ataAcct.data)
      new DataView(ataData.buffer, ataData.byteOffset)
        .setBigUint64(64, USDC_PRE_BALANCE, true)
      svm.setAccount(usdcAta, { ...ataAcct, data: ataData })
    }

    try {
      await client
        .requestRedemptionOnyc({
          payer: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          nttInboxItem: inboxItemPda,
          onre: { redemptionRequest: redemptionRequestPda },
        })
        .rpc()
    } catch (e: any) {
      console.log('REQUEST ERROR:', e.message)
      if (e.logs) {
        console.log('REQUEST LOGS:', e.logs)
      }
      throw e
    }

    const offerView = new DataView(
      svm.getAccount(redemptionOffer)!.data.buffer,
      svm.getAccount(redemptionOffer)!.data.byteOffset,
    )
    expect(offerView.getBigUint64(REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET, true)).toBe(43n)

    const reqAcct = svm.getAccount(redemptionRequestPda)!
    expect(reqAcct.lamports).toBeGreaterThan(0)
    expect(reqAcct.owner.toBase58()).toBe(
      new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe').toBase58(),
    )
    const reqView = new DataView(reqAcct.data.buffer, reqAcct.data.byteOffset)
    expect(reqView.getBigUint64(40, true)).toBe(42n) // request_id

    // Tracker bound to the counter=42 PDA — proves the relayer reads the
    // CPI-consumed account, not a caller-supplied alias.
    const tracker = svm.getAccount(redemptionTrackerPda)!
    const trackerRequest = new PublicKey(tracker.data.slice(40, 72))
    expect(trackerRequest.toBase58()).toBe(redemptionRequestPda.toBase58())

    const flow = svm.getAccount(outflightPda)!
    expect(flow.data[40]).toBe(FlowStatus.RedemptionPending)
    const recordedAmount = new DataView(flow.data.buffer, flow.data.byteOffset)
      .getBigUint64(41, true)
    expect(recordedAmount).toBe(NET_ONYC_TO_ONRE)
  })
})
