/**
 * Failure-path tests for the withdraw chain. Each test drives the system
 * into a specific pre-condition and asserts the relayer rejects with the
 * expected `RelayerError` (per `programs/relayer/src/error.rs`).
 *
 * Each test starts from a clean svm (beforeEach) with leg 1 (`unlock_onyc`)
 * already executed — i.e. an outflight Flow PDA exists at status `Claimed`.
 */

import type { WithdrawRig } from './utils'
import {
  findOnreRedemptionRequestPda,
  findRedemptionTrackerPda,
} from '@fogo-onre/sdk'
import { Keypair, PublicKey } from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  expectError,
  FlowStatus,
  pinOnreBinaryFixture,
  runUnlockOnycLeg1,
  setupWithdrawRig,
  synthesizeOnreRedemptionOffer,
  WITHDRAW_TEST_CONSTANTS,

} from './utils'

describe('withdraw failure paths', () => {
  let rig: WithdrawRig
  let inboxItemPda: PublicKey
  let outflightPda: PublicKey
  const { USDC_PRE_BALANCE } = WITHDRAW_TEST_CONSTANTS

  beforeEach(() => pinOnreBinaryFixture())
  beforeEach(async () => {
    rig = await setupWithdrawRig()
    const leg1 = await runUnlockOnycLeg1(rig)
    inboxItemPda = leg1.inboxItemPda
    outflightPda = leg1.outflightPda
  })

  function prefundUsdc(amount: bigint) {
    const ataAcct = rig.svm.getAccount(rig.usdcAta)!
    const ataData = new Uint8Array(ataAcct.data)
    new DataView(ataData.buffer, ataData.byteOffset).setBigUint64(64, amount, true)
    rig.svm.setAccount(rig.usdcAta, { ...ataAcct, data: ataData })
  }

  function setupOnreState(): { redemptionRequestPda: PublicKey } {
    const { redemptionOffer } = synthesizeOnreRedemptionOffer(
      rig.svm, rig.onycMint.publicKey, rig.usdcMint.publicKey,
    )
    const [redemptionRequestPda] = findOnreRedemptionRequestPda(redemptionOffer, 0n)
    return { redemptionRequestPda }
  }

  function callRequestRedemption(redemptionRequest: PublicKey) {
    return rig.client
      .requestRedemptionOnyc({
        payer: rig.authority.publicKey,
        usdcMint: rig.usdcMint.publicKey,
        onycMint: rig.onycMint.publicKey,
        nttInboxItem: inboxItemPda,
        onre: { redemptionRequest },
      })
      .rpc()
  }

  function callClaimRedemption(redemptionRequest: PublicKey) {
    return rig.client
      .claimRedemptionUsdc({
        cranker: rig.authority.publicKey,
        usdcMint: rig.usdcMint.publicKey,
        nttInboxItem: inboxItemPda,
        redemptionRequest,
        payerForClose: rig.authority.publicKey,
      })
      .rpc()
  }

  it('flowStatusMismatch on requestRedemptionOnyc when flow is RedemptionPending', async () => {
    prefundUsdc(USDC_PRE_BALANCE)
    const { redemptionRequestPda } = setupOnreState()

    // Force the Flow status byte to RedemptionPending (offset 40), bypassing
    // the legitimate path that would also create a singleton tracker.
    {
      const acct = rig.svm.getAccount(outflightPda)!
      const data = new Uint8Array(acct.data)
      data[40] = FlowStatus.RedemptionPending
      rig.svm.setAccount(outflightPda, { ...acct, data })
    }

    await expectError(
      () => callRequestRedemption(redemptionRequestPda),
      'FlowStatusMismatch',
    )
  })

  it('zeroAmountFlow on requestRedemptionOnyc when flow.amount is 0', async () => {
    prefundUsdc(USDC_PRE_BALANCE)
    const { redemptionRequestPda } = setupOnreState()

    // amount sits at offset 41 (status=40, amount u64=41..49).
    const acct = rig.svm.getAccount(outflightPda)!
    const data = new Uint8Array(acct.data)
    new DataView(data.buffer, data.byteOffset).setBigUint64(41, 0n, true)
    rig.svm.setAccount(outflightPda, { ...acct, data })

    await expectError(
      () => callRequestRedemption(redemptionRequestPda),
      'ZeroAmountFlow',
    )
  })

  it('singleton mutex blocks a second requestRedemptionOnyc', async () => {
    prefundUsdc(USDC_PRE_BALANCE)
    const { redemptionRequestPda } = setupOnreState()

    await callRequestRedemption(redemptionRequestPda)

    // Second call: tracker PDA already exists → Anchor `init` constraint
    // fails inside the system-program create_account call. LiteSVM surfaces
    // this as a transaction error without inline logs (the failure happens
    // pre-handler so no `Program log:` lines emit), so we just assert the
    // tx threw — the prior call already proves the singleton was created.
    let threw = false
    try {
      await callRequestRedemption(redemptionRequestPda)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)

    const [trackerPda] = findRedemptionTrackerPda(rig.client.program.programId)
    expect(rig.svm.getAccount(trackerPda)).not.toBeNull()
  })

  it('redemptionTrackerFlowMismatch on claimRedemptionUsdc when tracker.flow is bogus', async () => {
    prefundUsdc(USDC_PRE_BALANCE)
    const { redemptionRequestPda } = setupOnreState()
    await callRequestRedemption(redemptionRequestPda)

    // Tracker layout: disc(8) + flow(32) + redemption_request(32) + ...
    // Overwrite flow at offset 8 with a bogus key.
    const [trackerPda] = findRedemptionTrackerPda(rig.client.program.programId)
    {
      const acct = rig.svm.getAccount(trackerPda)!
      const data = new Uint8Array(acct.data)
      data.set(Keypair.generate().publicKey.toBytes(), 8)
      rig.svm.setAccount(trackerPda, { ...acct, data })
    }

    await expectError(
      () => callClaimRedemption(redemptionRequestPda),
      'RedemptionTrackerFlowMismatch',
    )
  })

  it('redemptionNotFulfilled on claimRedemptionUsdc when request PDA is still alive', async () => {
    prefundUsdc(USDC_PRE_BALANCE)
    const { redemptionRequestPda } = setupOnreState()
    await callRequestRedemption(redemptionRequestPda)

    // No fulfillment synthesis: OnRe-owned RedemptionRequest PDA still has
    // lamports + data + non-system owner. claim should reject.
    await expectError(
      () => callClaimRedemption(redemptionRequestPda),
      'RedemptionNotFulfilled',
    )
  })

  it('redemptionRequestMismatch on claimRedemptionUsdc when wrong PDA is passed', async () => {
    prefundUsdc(USDC_PRE_BALANCE)
    const { redemptionRequestPda } = setupOnreState()
    await callRequestRedemption(redemptionRequestPda)

    const bogus = Keypair.generate().publicKey

    await expectError(
      () => callClaimRedemption(bogus),
      'RedemptionRequestMismatch',
    )
  })
})
