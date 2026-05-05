/**
 * Withdraw-chain e2e covering legs 1-3:
 *   unlock_onyc → request_redemption_onyc → claim_redemption_usdc
 *
 * **Real CPI coverage** (3 of 3 legs):
 *   - leg 1  unlock_onyc           — NTT redeem + release_inbound_unlock against the NTT `.so` (Locking mode)
 *   - leg 2  request_redemption_onyc — full relayer handler + real OnRe `create_redemption_request` CPI
 *                                    against the OnRe `.so`. Withdraw-side OnRe state (RedemptionOffer
 *                                    + vault ATA) is synthesized from the upstream struct definitions
 *                                    in `tests/utils/onre-fixtures.ts::synthesizeOnreRedemptionOffer`.
 *   - leg 3  claim_redemption_usdc — full relayer handler (issues no CPI of its own; just verifies the
 *                                    closed `RedemptionRequest` PDA, computes USDC delta, advances
 *                                    Flow, closes singleton tracker)
 *
 * Leg 4 (`send_usdc_to_user`) lives in `send-usdc-to-user-e2e.test.ts`. It cannot
 * be exercised here because NTT's Config PDA is a per-program singleton, and this
 * rig binds it to the ONyc mint for leg 1 — leg 4 needs USDC.s as the NTT-managed
 * mint instead.
 *
 * **Synthesized** (off-chain admin step):
 *   OnRe `redemption_admin` fulfillment — close the `RedemptionRequest` PDA (zero lamports,
 *   system-owned, empty data) and credit USDC to the relayer ATA. This mirrors what
 *   `fulfill_redemption_request` does on chain. The `redemption_admin` keypair is
 *   OnRe-private, so this step cannot be invoked from a test environment — synthesizing
 *   the post-state is the only viable approach.
 */

import type { WithdrawRig } from './utils'
import {
  findOnreRedemptionRequestPda,
  findOnreRedemptionVaultAuthorityPda,
  findRedemptionTrackerPda,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FlowStatus,
  pinBinaryFixtures,
  runUnlockOnycLeg1,
  setupWithdrawRig,
  synthesizeOnreRedemptionOffer,
  WITHDRAW_TEST_CONSTANTS,
} from './utils'

describe('withdraw flow e2e (unlock_onyc → request_redemption_onyc → claim_redemption_usdc)', () => {
  let rig: WithdrawRig

  const {
    ONYC_RELEASED,
    NET_ONYC_TO_ONRE,
    USDC_PRE_BALANCE,
  } = WITHDRAW_TEST_CONSTANTS

  // OnRe pays ~1:1 in this test.
  const USDC_FROM_REDEMPTION = 990_000n

  // Sanity-pin: synthesized NET_ONYC_TO_ONRE must match what the relayer
  // would compute on-chain in `request_redemption_onyc` from a 100-bps
  // withdraw fee. Fires at the start of every test if `initialize` drifts.
  beforeEach(() => {
    const computed = ONYC_RELEASED - (ONYC_RELEASED * 100n) / 10_000n
    if (computed !== NET_ONYC_TO_ONRE) {
      throw new Error(
        `Withdraw-fee math drift: expected NET_ONYC_TO_ONRE=${NET_ONYC_TO_ONRE}, got ${computed}`,
      )
    }
  })

  beforeEach(() => pinBinaryFixtures())
  beforeEach(async () => {
    rig = await setupWithdrawRig()
  })

  it('chains real NTT inbound + real request_redemption_onyc + real claim_redemption_usdc', async () => {
    const {
      svm,
      authority,
      client,
      usdcMint,
      onycMint,
      relayerAuthorityPda,
      onycAta,
      usdcAta,
    } = rig

    const { inboxItemPda, outflightPda } = await runUnlockOnycLeg1(rig)

    // Leg 1 post-conditions: outflight Flow at Claimed, ONyc in relayer ATA.
    {
      const flow = svm.getAccount(outflightPda)
      expect(flow).not.toBeNull()
      expect(flow!.data[40]).toBe(FlowStatus.Claimed)
      const recordedAmount = new DataView(flow!.data.buffer, flow!.data.byteOffset)
        .getBigUint64(41, true)
      expect(recordedAmount).toBe(ONYC_RELEASED)

      const ata = svm.getAccount(onycAta)!
      const bal = new DataView(ata.data.buffer, ata.data.byteOffset).getBigUint64(64, true)
      expect(bal).toBe(ONYC_RELEASED)
    }

    // Leg 2 — REAL request_redemption_onyc (CPIs OnRe).
    const { redemptionOffer } = synthesizeOnreRedemptionOffer(
      svm,
      onycMint.publicKey,
      usdcMint.publicKey,
    )
    const [redemptionRequestPda] = findOnreRedemptionRequestPda(redemptionOffer, 0n)
    const [redemptionTrackerPda] = findRedemptionTrackerPda(client.program.programId)

    {
      // Pre-fund the relayer USDC ATA — leg 3 computes
      // `usdc_ata.amount - tracker.usdc_ata_pre_balance`, so the snapshot
      // request_redemption_onyc takes here must be > 0 for the test to
      // exercise the delta path. The ATA was created by `initialize`.
      const ataAcct = svm.getAccount(usdcAta)!
      const ataData = new Uint8Array(ataAcct.data)
      new DataView(ataData.buffer, ataData.byteOffset)
        .setBigUint64(64, USDC_PRE_BALANCE, true)
      svm.setAccount(usdcAta, { ...ataAcct, data: ataData })

      // Bump USDC mint supply to cover pre + post-redemption credit.
      const mintAcct = svm.getAccount(usdcMint.publicKey)!
      const mintData = new Uint8Array(mintAcct.data)
      new DataView(mintData.buffer, mintData.byteOffset)
        .setBigUint64(36, USDC_PRE_BALANCE + USDC_FROM_REDEMPTION, true)
      svm.setAccount(usdcMint.publicKey, { ...mintAcct, data: mintData })
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
      console.log('REQUEST_REDEMPTION ERROR:', e.message)
      if (e.logs) {
        console.log('REQUEST_REDEMPTION LOGS:', e.logs)
      }
      throw e
    }

    // Leg 2 post-conditions: prove the real OnRe binary executed.
    {
      const flow = svm.getAccount(outflightPda)!
      expect(flow.data[40]).toBe(FlowStatus.RedemptionPending)
      const recordedAmount = new DataView(flow.data.buffer, flow.data.byteOffset)
        .getBigUint64(41, true)
      expect(recordedAmount).toBe(NET_ONYC_TO_ONRE)

      const tracker = svm.getAccount(redemptionTrackerPda)!
      const trackerRequest = new PublicKey(tracker.data.slice(40, 72))
      expect(trackerRequest.toBase58()).toBe(redemptionRequestPda.toBase58())

      const offerAcct = svm.getAccount(redemptionOffer)!
      expect(offerAcct.owner.toBase58()).toBe(
        new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe').toBase58(),
      )
      const offerView = new DataView(offerAcct.data.buffer, offerAcct.data.byteOffset)
      expect(offerView.getBigUint64(120, true)).toBe(NET_ONYC_TO_ONRE)
      expect(offerView.getBigUint64(128, true)).toBe(0n)
      expect(offerView.getBigUint64(138, true)).toBe(1n)

      const [vaultAuthority] = findOnreRedemptionVaultAuthorityPda()
      const vaultAta = getAssociatedTokenAddressSync(
        onycMint.publicKey, vaultAuthority, true,
      )
      const vaultAcct = svm.getAccount(vaultAta)!
      const vaultBal = new DataView(vaultAcct.data.buffer, vaultAcct.data.byteOffset)
        .getBigUint64(64, true)
      expect(vaultBal).toBe(NET_ONYC_TO_ONRE)

      const reqAcct = svm.getAccount(redemptionRequestPda)!
      expect(reqAcct.lamports).toBeGreaterThan(0)
      expect(reqAcct.owner.toBase58()).toBe(
        new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe').toBase58(),
      )
      const reqDisc = Array.from(reqAcct.data.slice(0, 8))
      expect(reqDisc).toEqual([117, 157, 214, 214, 64, 160, 31, 58])
      const reqOffer = new PublicKey(reqAcct.data.slice(8, 40))
      expect(reqOffer.toBase58()).toBe(redemptionOffer.toBase58())
      const reqView = new DataView(reqAcct.data.buffer, reqAcct.data.byteOffset)
      expect(reqView.getBigUint64(40, true)).toBe(0n)
      const reqRedeemer = new PublicKey(reqAcct.data.slice(48, 80))
      expect(reqRedeemer.toBase58()).toBe(relayerAuthorityPda.toBase58())
      expect(reqView.getBigUint64(80, true)).toBe(NET_ONYC_TO_ONRE)
    }

    // OnRe `redemption_admin` fulfillment (synthesized).
    {
      svm.setAccount(redemptionRequestPda, {
        executable: false,
        owner: SystemProgram.programId,
        lamports: 0,
        data: new Uint8Array(0),
        rentEpoch: 0,
      })

      const ataAcct = svm.getAccount(usdcAta)!
      const ataData = new Uint8Array(ataAcct.data)
      new DataView(ataData.buffer, ataData.byteOffset)
        .setBigUint64(64, USDC_PRE_BALANCE + USDC_FROM_REDEMPTION, true)
      svm.setAccount(usdcAta, { ...ataAcct, data: ataData })
    }

    try {
      await client
        .claimRedemptionUsdc({
          cranker: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          nttInboxItem: inboxItemPda,
          redemptionRequest: redemptionRequestPda,
          payerForClose: authority.publicKey,
        })
        .rpc()
    } catch (e: any) {
      console.log('CLAIM_REDEMPTION ERROR:', e.message)
      if (e.logs) {
        console.log('CLAIM_REDEMPTION LOGS:', e.logs)
      }
      throw e
    }

    // Leg 3 post-conditions: Flow at Swapped with USDC delta;
    // RedemptionTracker PDA closed (rent refunded to authority).
    {
      const flow = svm.getAccount(outflightPda)
      expect(flow).not.toBeNull()
      expect(flow!.data[40]).toBe(FlowStatus.Swapped)
      const recordedAmount = new DataView(flow!.data.buffer, flow!.data.byteOffset)
        .getBigUint64(41, true)
      expect(recordedAmount).toBe(USDC_FROM_REDEMPTION)

      const tracker = svm.getAccount(redemptionTrackerPda)
      if (tracker !== null) {
        expect(tracker.owner.toBase58()).toEqual(SystemProgram.programId.toBase58())
        expect(tracker.data.length).toBe(0)
      }
    }
  })
})
