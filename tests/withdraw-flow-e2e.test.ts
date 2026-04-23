/**
 * Full withdraw-chain e2e:
 *   unlock_onyc → request_redemption_onyc → claim_redemption_usdc → send_usdc_to_user
 *
 * **Real CPI coverage** (4 of 4 legs):
 *   - leg 1  unlock_onyc           — NTT redeem + release_inbound_unlock against the NTT `.so` (Locking mode)
 *   - leg 2  request_redemption_onyc — full relayer handler + real OnRe `create_redemption_request` CPI
 *                                    against the OnRe `.so`. Withdraw-side OnRe state (RedemptionOffer
 *                                    + vault ATA) is synthesized from the upstream struct definitions
 *                                    in `tests/utils/onre-fixtures.ts::synthesizeOnreRedemptionOffer`,
 *                                    not captured from mainnet — the layout is fully known and `state`
 *                                    is the only mainnet-cloned account this leg needs.
 *   - leg 3  claim_redemption_usdc — full relayer handler (issues no CPI of its own; just verifies the
 *                                    closed `RedemptionRequest` PDA, computes USDC delta, advances
 *                                    Flow, closes singleton tracker)
 *   - leg 4  send_usdc_to_user     — TB `TransferWrappedWithPayload` against the Token Bridge `.so`
 *
 * **Synthesized** (off-chain admin step):
 *   OnRe `redemption_admin` fulfillment — close the `RedemptionRequest` PDA (zero lamports,
 *   system-owned, empty data) and credit USDC to the relayer ATA. This mirrors what
 *   `fulfill_redemption_request` does on chain. There is no instruction the relayer issues
 *   for this; the relayer only *observes* it via the closed-PDA signal that
 *   `claim_redemption_usdc` checks. The `redemption_admin` keypair is OnRe-private, so this
 *   step cannot be invoked from a test environment — synthesizing the post-state is the
 *   only viable approach.
 */

import type { WithdrawRig } from './utils'
import {
  findCoreBridgeSequencePda,
  findOnreRedemptionRequestPda,
  findOnreRedemptionVaultAuthorityPda,
  findRedemptionTrackerPda,
  findTokenBridgeEmitterPda,
  FOGO_WORMHOLE_CHAIN_ID,
  WORMHOLE_CORE_BRIDGE_ID,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FlowStatus,
  pinOnreBinaryFixture,
  runUnlockOnycLeg1,
  setupWithdrawRig,
  synthesizeOnreRedemptionOffer,
  WITHDRAW_TEST_CONSTANTS,

} from './utils'

describe('withdraw flow e2e (unlock_onyc → [request_redemption_onyc synth] → claim_redemption_usdc → send_usdc_to_user)', () => {
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

  beforeEach(() => pinOnreBinaryFixture())
  beforeEach(async () => {
    rig = await setupWithdrawRig()
  })

  it('chains real NTT inbound + real claim_redemption_usdc + real TB outbound', async () => {
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
    // Synthesize OnRe withdraw-side state from scratch (RedemptionOffer
    // + vault ATA), derive the RedemptionRequest PDA from
    // request_counter=0 (fresh offer), pre-fund USDC ATA so leg 3's
    // delta math has a non-zero baseline, then call the relayer.
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

      // Bump wrapped-USDC mint supply (covers pre + post for leg 4's burn).
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
    //
    // Each assertion below checks a state mutation that ONLY the real
    // binary's `create_redemption_request` handler performs — none of the
    // relayer-side bookkeeping or Anchor's stub success-paths would
    // produce these:
    //
    //   1. Flow advances Claimed → RedemptionPending with `amount = net`.
    //   2. RedemptionTracker initialized with `tracker.redemption_request`
    //      bound to the PDA OnRe just created (relayer-side binding from
    //      `ctx.remaining_accounts[INDEX=2]` after the CPI returns Ok).
    //   3. RedemptionOffer.request_counter incremented 0 → 1.
    //   4. RedemptionOffer.requested_redemptions credited NET_ONYC_TO_ONRE.
    //   5. Vault ONyc ATA holds NET_ONYC_TO_ONRE.
    //   6. RedemptionRequest PDA written with the canonical layout.
    {
      const flow = svm.getAccount(outflightPda)!
      expect(flow.data[40]).toBe(FlowStatus.RedemptionPending)
      const recordedAmount = new DataView(flow.data.buffer, flow.data.byteOffset)
        .getBigUint64(41, true)
      expect(recordedAmount).toBe(NET_ONYC_TO_ONRE)

      const tracker = svm.getAccount(redemptionTrackerPda)!
      // Tracker layout: disc(8) + flow(32) + redemption_request(32) + ...
      const trackerRequest = new PublicKey(tracker.data.slice(40, 72))
      expect(trackerRequest.toBase58()).toBe(redemptionRequestPda.toBase58())

      const offerAcct = svm.getAccount(redemptionOffer)!
      expect(offerAcct.owner.toBase58()).toBe(
        new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe').toBase58(),
      )
      const offerView = new DataView(offerAcct.data.buffer, offerAcct.data.byteOffset)
      // requested_redemptions u128 LE at offset 120
      expect(offerView.getBigUint64(120, true)).toBe(NET_ONYC_TO_ONRE)
      expect(offerView.getBigUint64(128, true)).toBe(0n) // u128 high half
      // request_counter u64 LE at offset 138
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
      // RedemptionRequest layout: disc(8) + offer(32) + request_id(8) +
      // redeemer(32) + amount(8) + bump(1) + reserved[127]
      // Anchor account discriminator = sha256("account:RedemptionRequest")[..8]
      const reqDisc = Array.from(reqAcct.data.slice(0, 8))
      expect(reqDisc).toEqual([117, 157, 214, 214, 64, 160, 31, 58])
      const reqOffer = new PublicKey(reqAcct.data.slice(8, 40))
      expect(reqOffer.toBase58()).toBe(redemptionOffer.toBase58())
      const reqView = new DataView(reqAcct.data.buffer, reqAcct.data.byteOffset)
      expect(reqView.getBigUint64(40, true)).toBe(0n) // request_id
      const reqRedeemer = new PublicKey(reqAcct.data.slice(48, 80))
      expect(reqRedeemer.toBase58()).toBe(relayerAuthorityPda.toBase58())
      expect(reqView.getBigUint64(80, true)).toBe(NET_ONYC_TO_ONRE)
    }

    // OnRe `redemption_admin` fulfillment (synthesized). Two effects on chain:
    //   (a) `RedemptionRequest` PDA closed (zero lamports, system-owned,
    //       empty data) — the signal `claim_redemption_usdc` checks.
    //   (b) USDC delta credited to the relayer USDC ATA.
    {
      // LiteSVM treats a "closed" account as owner == system_program::ID
      // and zero-length data. `claim_redemption_usdc`'s
      // RedemptionNotFulfilled check requires `lamports() == 0`.
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

      // Anchor's `close` constraint reverts ownership to the system program
      // and zeroes data — but the account may also be fully absent.
      const tracker = svm.getAccount(redemptionTrackerPda)
      if (tracker !== null) {
        expect(tracker.owner.toBase58()).toEqual(SystemProgram.programId.toBase58())
        expect(tracker.data.length).toBe(0)
      }
    }

    const messageKp = Keypair.generate()
    try {
      await client
        .sendUsdcToUser({
          payer: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          nttInboxItem: inboxItemPda,
          rentDestination: authority.publicKey,
          tokenBridge: {
            wrappedMint: usdcMint.publicKey,
            recipientChain: FOGO_WORMHOLE_CHAIN_ID,
          },
          message: messageKp.publicKey,
        })
        .signers([messageKp])
        .rpc()
    } catch (e: any) {
      console.log('SEND ERROR:', e.message)
      if (e.logs) {
        console.log('SEND LOGS:', e.logs)
      }
      throw e
    }

    // Leg 4 post-conditions: Flow PDA closed (rent refunded), USDC ATA
    // burns the post-redemption delta back down to the pre-balance the
    // ATA started with (only `flow.amount = USDC_FROM_REDEMPTION` is
    // burned; pre-existing USDC stays).
    expect(svm.getAccount(outflightPda)).toBeNull()

    const finalAta = svm.getAccount(usdcAta)!
    const finalBal = new DataView(finalAta.data.buffer, finalAta.data.byteOffset)
      .getBigUint64(64, true)
    expect(finalBal).toEqual(USDC_PRE_BALANCE)

    const messageAcct = svm.getAccount(messageKp.publicKey)
    expect(messageAcct).not.toBeNull()
    expect(messageAcct!.owner.toBase58()).toEqual(WORMHOLE_CORE_BRIDGE_ID.toBase58())

    const [emitterPda] = findTokenBridgeEmitterPda()
    const [sequencePda] = findCoreBridgeSequencePda(emitterPda)
    const seqAcct = svm.getAccount(sequencePda)
    expect(seqAcct).not.toBeNull()
    expect(seqAcct!.owner.toBase58()).toEqual(WORMHOLE_CORE_BRIDGE_ID.toBase58())
  })
})
