/**
 * `cancel_redemption_onyc` e2e: drives the withdraw chain into
 * `RedemptionPending` via real `unlock_onyc` + real `request_redemption_onyc`
 * (CPI into the mainnet OnRe binary), then exercises the recovery hatch and
 * asserts the real OnRe binary's `cancel_redemption_request` ran:
 *
 *   - Flow status reverts to Claimed with `flow.amount == NET_ONYC_TO_ONRE`.
 *   - Singleton RedemptionTracker is closed (system-owned, zero data).
 *   - OnRe-owned RedemptionRequest PDA is closed.
 *   - Vault ONyc ATA balance drops back to 0; relayer's `onyc_ata` regains
 *     the locked NET_ONYC_TO_ONRE.
 */

import type { WithdrawRig } from './utils'
import {
  findOnreRedemptionRequestPda,
  findOnreRedemptionVaultAuthorityPda,
  findRedemptionTrackerPda,
  ONRE_STATE_FIXTURE,
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

// State layout: disc(8) + boss(32) + proposed_boss(32) + is_killed(1)
//   + onyc_mint(32) + admins[20*32=640] + approver1(32) + approver2(32)
//   + bump(1) + max_supply(8) + redemption_admin(32) + reserved[96]
const STATE_REDEMPTION_ADMIN_OFFSET = 818

describe('cancel_redemption_onyc e2e', () => {
  let rig: WithdrawRig
  const { NET_ONYC_TO_ONRE, USDC_PRE_BALANCE } = WITHDRAW_TEST_CONSTANTS

  beforeEach(() => pinBinaryFixtures())
  beforeEach(async () => {
    rig = await setupWithdrawRig()
  })

  it('aborts a pending OnRe redemption and rolls flow back to Claimed', async () => {
    const { svm, authority, client, usdcMint, onycMint, onycAta, usdcAta } = rig

    const { inboxItemPda, outflightPda } = await runUnlockOnycLeg1(rig)

    const { redemptionOffer } = synthesizeOnreRedemptionOffer(
      svm, onycMint.publicKey, usdcMint.publicKey,
    )
    const [redemptionRequestPda] = findOnreRedemptionRequestPda(redemptionOffer, 0n)
    const [redemptionTrackerPda] = findRedemptionTrackerPda(client.program.programId)

    {
      const ataAcct = svm.getAccount(usdcAta)!
      const ataData = new Uint8Array(ataAcct.data)
      new DataView(ataData.buffer, ataData.byteOffset)
        .setBigUint64(64, USDC_PRE_BALANCE, true)
      svm.setAccount(usdcAta, { ...ataAcct, data: ataData })

      const mintAcct = svm.getAccount(usdcMint.publicKey)!
      const mintData = new Uint8Array(mintAcct.data)
      new DataView(mintData.buffer, mintData.byteOffset)
        .setBigUint64(36, USDC_PRE_BALANCE, true)
      svm.setAccount(usdcMint.publicKey, { ...mintAcct, data: mintData })
    }

    await client
      .requestRedemptionOnyc({
        payer: authority.publicKey,
        usdcMint: usdcMint.publicKey,
        onycMint: onycMint.publicKey,
        nttInboxItem: inboxItemPda,
        onre: { redemptionRequest: redemptionRequestPda },
      })
      .rpc()

    // Pre-cancel snapshot: relayer onyc_ata is empty (the net was moved
    // into OnRe's vault by the request CPI; the fee was siphoned to fee_vault).
    {
      const ata = svm.getAccount(onycAta)!
      const bal = new DataView(ata.data.buffer, ata.data.byteOffset).getBigUint64(64, true)
      expect(bal).toBe(0n)
    }

    const stateAcct = svm.getAccount(new PublicKey(ONRE_STATE_FIXTURE))!
    const redemptionAdmin = new PublicKey(
      stateAcct.data.slice(STATE_REDEMPTION_ADMIN_OFFSET, STATE_REDEMPTION_ADMIN_OFFSET + 32),
    )

    try {
      await client
        .cancelRedemptionOnyc({
          authority: authority.publicKey,
          onycMint: onycMint.publicKey,
          nttInboxItem: inboxItemPda,
          payerForClose: authority.publicKey,
          onre: {
            redemptionRequest: redemptionRequestPda,
            redemptionAdmin,
            usdcMint: usdcMint.publicKey,
          },
        })
        .rpc()
    } catch (e: any) {
      console.log('CANCEL ERROR:', e.message)
      if (e.logs) {
        console.log('CANCEL LOGS:', e.logs)
      }
      throw e
    }

    const flow = svm.getAccount(outflightPda)!
    expect(flow.data[40]).toBe(FlowStatus.Claimed)
    const recordedAmount = new DataView(flow.data.buffer, flow.data.byteOffset)
      .getBigUint64(41, true)
    expect(recordedAmount).toBe(NET_ONYC_TO_ONRE)

    // Singleton RedemptionTracker closed (Anchor `close` reverts ownership
    // to the system program and zeroes data).
    const tracker = svm.getAccount(redemptionTrackerPda)
    if (tracker !== null) {
      expect(tracker.owner.toBase58()).toEqual(SystemProgram.programId.toBase58())
      expect(tracker.data.length).toBe(0)
    }

    const reqAcct = svm.getAccount(redemptionRequestPda)
    if (reqAcct !== null) {
      expect(reqAcct.lamports).toBe(0)
    }

    const [vaultAuthority] = findOnreRedemptionVaultAuthorityPda()
    const vaultAta = getAssociatedTokenAddressSync(onycMint.publicKey, vaultAuthority, true)
    const vaultBal = new DataView(
      svm.getAccount(vaultAta)!.data.buffer,
      svm.getAccount(vaultAta)!.data.byteOffset,
    ).getBigUint64(64, true)
    expect(vaultBal).toBe(0n)

    // Pre-cancel relayer onyc_ata balance was 0 (entire net was in OnRe's
    // vault), so post-cancel balance equals NET_ONYC_TO_ONRE.
    const finalOnycAta = svm.getAccount(onycAta)!
    const finalOnycBal = new DataView(
      finalOnycAta.data.buffer, finalOnycAta.data.byteOffset,
    ).getBigUint64(64, true)
    expect(finalOnycBal).toBe(NET_ONYC_TO_ONRE)
  })
})
