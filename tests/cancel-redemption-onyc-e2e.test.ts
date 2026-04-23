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
 *
 * Setup boilerplate is shared with `withdraw-flow-e2e.test.ts`.
 */

import type { LiteSVM } from 'litesvm'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findAuthorityPda,
  findInboxItemPda,
  findOnreRedemptionRequestPda,
  findOnreRedemptionVaultAuthorityPda,
  findOutflightFlowPda,
  findRedemptionTrackerPda,
  findTokenAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_PROGRAM_ID,
  ONRE_STATE_FIXTURE,
  RelayerClient,
} from '@fogo-onre/sdk'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { Clock } from 'litesvm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeInboxItemHash,
  createAta,
  createMintWithAuthority,
  createProvider,
  createSvm,
  createWrappedMint,
  findValidatedTransceiverMessagePda,
  FlowStatus,
  loadAndPatchNttConfig,
  loadFixture,
  NTT_INBOX_RL_FIXTURE,
  NTT_OUTBOX_RL_FIXTURE,
  NTT_PEER_FIXTURE,
  readPeerAddress,
  setRegisteredTransceiver,
  setupForeignEndpoint,
  setupMintAuthority,
  setupTokenBridgeConfig,
  setupWrappedMeta,
  setValidatedTransceiverMessage,
  synthesizeOnreRedemptionOffer,
} from './utils'

// State layout: disc(8) + boss(32) + proposed_boss(32) + is_killed(1)
//   + onyc_mint(32) + admins[20*32=640] + approver1(32) + approver2(32)
//   + bump(1) + max_supply(8) + redemption_admin(32) + reserved[96]
const STATE_REDEMPTION_ADMIN_OFFSET = 818

describe('cancel_redemption_onyc e2e', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: { publicKey: PublicKey }
  let onycMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let custodyAta: PublicKey
  let onycAta: PublicKey
  let usdcAta: PublicKey

  const ONYC_RELEASED = 1_000_000n
  const NET_ONYC_TO_ONRE = 990_000n
  const CUSTODY_BALANCE = 10_000_000n
  const USDC_PRE_BALANCE = 50_000n

  const FOGO_TB_EMITTER = new Uint8Array(32).fill(0xEE)
  const USDCS_TOKEN_ADDR = new Uint8Array(32).fill(0xCC)
  const fogoSender = new Uint8Array(32).fill(0x7F)

  const ONRE_MAINNET_BINARY_SHA256
    = 'abcea77d935ca5eb512f43a1b3a6241151c2efa74c80b7bd9a600b959f65f7d6'
  beforeEach(() => {
    const here = dirname(fileURLToPath(import.meta.url))
    const so = readFileSync(
      join(here, 'fixtures/programs/onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe.so'),
    )
    const got = createHash('sha256').update(so).digest('hex')
    if (got !== ONRE_MAINNET_BINARY_SHA256) {
      throw new Error(
        `OnRe binary fixture drift: expected sha256=${ONRE_MAINNET_BINARY_SHA256}, got ${got}.`,
      )
    }
  })

  beforeEach(async () => {
    svm = createSvm()
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    ;[nttTokenAuthorityPda] = findTokenAuthorityPda()

    usdcMint = createWrappedMint(svm, FOGO_WORMHOLE_CHAIN_ID, USDCS_TOKEN_ADDR, 6)
    onycMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)
    const feeVault = createAta(svm, authority, onycMint.publicKey, authority.publicKey)

    setupTokenBridgeConfig(svm)
    setupForeignEndpoint(svm, FOGO_WORMHOLE_CHAIN_ID, FOGO_TB_EMITTER)
    setupWrappedMeta(svm, usdcMint.publicKey, FOGO_WORMHOLE_CHAIN_ID, USDCS_TOKEN_ADDR, 6)
    setupMintAuthority(svm)

    await client
      .initialize({
        authority: authority.publicKey,
        usdcMint: usdcMint.publicKey,
        onycMint: onycMint.publicKey,
        feeVault,
        depositFeeBps: 50,
        withdrawFeeBps: 100,
      })
      .rpc()

    relayerAuthorityPda = client.authorityPda
    onycAta = getAssociatedTokenAddressSync(onycMint.publicKey, relayerAuthorityPda, true)
    usdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, relayerAuthorityPda, true)

    custodyAta = getAssociatedTokenAddressSync(onycMint.publicKey, nttTokenAuthorityPda, true)
    {
      const data = new Uint8Array(165)
      data.set(onycMint.publicKey.toBytes(), 0)
      data.set(nttTokenAuthorityPda.toBytes(), 32)
      new DataView(data.buffer).setBigUint64(64, CUSTODY_BALANCE, true)
      data[108] = 1
      svm.setAccount(custodyAta, {
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 2_039_280,
        data,
        rentEpoch: 0,
      })
    }
    {
      const acct = svm.getAccount(onycMint.publicKey)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer).setBigUint64(36, CUSTODY_BALANCE, true)
      svm.setAccount(onycMint.publicKey, { ...acct, data })
    }

    loadAndPatchNttConfig(svm, onycMint.publicKey, custodyAta)
    loadFixture(svm, NTT_PEER_FIXTURE)
    loadFixture(svm, NTT_INBOX_RL_FIXTURE)
    loadFixture(svm, NTT_OUTBOX_RL_FIXTURE)
    {
      const pda = new PublicKey(NTT_OUTBOX_RL_FIXTURE)
      const acct = svm.getAccount(pda)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer).setBigInt64(24, 0n, true)
      svm.setAccount(pda, { ...acct, data })
    }
    {
      const pda = new PublicKey(NTT_INBOX_RL_FIXTURE)
      const acct = svm.getAccount(pda)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer).setBigInt64(25, 0n, true)
      svm.setAccount(pda, { ...acct, data })
    }
    setRegisteredTransceiver(svm, NTT_PROGRAM_ID, 0)

    loadFixture(svm, ONRE_STATE_FIXTURE)

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  it('aborts a pending OnRe redemption and rolls flow back to Claimed', async () => {
    // ─── Leg 1: real NTT redeem + release_inbound_unlock ───────────
    const messageId = new Uint8Array(32)
    crypto.getRandomValues(messageId)
    const peerAddress = readPeerAddress(svm)
    const sourceToken = new Uint8Array(32).fill(0x22)

    const message = {
      id: messageId,
      sender: fogoSender,
      trimmedAmount: ONYC_RELEASED,
      trimmedDecimals: 6,
      sourceToken,
      toChain: 1,
      to: relayerAuthorityPda.toBytes(),
    }

    const [validatedMsgPda] = findValidatedTransceiverMessagePda(
      FOGO_WORMHOLE_CHAIN_ID, messageId, NTT_PROGRAM_ID,
    )
    setValidatedTransceiverMessage(svm, validatedMsgPda, NTT_PROGRAM_ID, {
      fromChain: FOGO_WORMHOLE_CHAIN_ID,
      sourceNttManager: peerAddress,
      recipientNttManager: NTT_PROGRAM_ID.toBytes(),
      message,
    })

    const msgHash = computeInboxItemHash(FOGO_WORMHOLE_CHAIN_ID, message, keccak_256)
    const [inboxItemPda] = findInboxItemPda(msgHash)

    await client
      .unlockOnyc({
        payer: authority.publicKey,
        onycMint: onycMint.publicKey,
        nttInboxItem: inboxItemPda,
        nttTransceiverMessage: validatedMsgPda,
        ntt: { transceiverAddress: NTT_PROGRAM_ID, custody: custodyAta },
      })
      .rpc()

    // ─── Leg 2: real request_redemption_onyc (CPI into OnRe) ────────
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

    const [outflightPda] = findOutflightFlowPda(inboxItemPda, client.program.programId)

    // Pre-cancel snapshots: relayer onyc_ata is empty (the net was moved
    // into OnRe's vault by leg 2's CPI; the fee was siphoned to fee_vault).
    {
      const ata = svm.getAccount(onycAta)!
      const bal = new DataView(ata.data.buffer, ata.data.byteOffset).getBigUint64(64, true)
      expect(bal).toBe(0n)
    }

    // ─── Cancel ─────────────────────────────────────────────────────
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

    // Post-conditions — all proven only by the real OnRe binary executing
    // `cancel_redemption_request` plus the relayer handler running to
    // completion (would not happen if the CPI errored).

    // 1. Flow rolled back to Claimed with returned amount.
    const flow = svm.getAccount(outflightPda)!
    expect(flow.data[40]).toBe(FlowStatus.Claimed)
    const recordedAmount = new DataView(flow.data.buffer, flow.data.byteOffset)
      .getBigUint64(41, true)
    expect(recordedAmount).toBe(NET_ONYC_TO_ONRE)

    // 2. Singleton RedemptionTracker closed (Anchor `close` reverts
    //    ownership to the system program and zeroes data).
    const tracker = svm.getAccount(redemptionTrackerPda)
    if (tracker !== null) {
      expect(tracker.owner.toBase58()).toEqual(SystemProgram.programId.toBase58())
      expect(tracker.data.length).toBe(0)
    }

    // 3. OnRe-owned RedemptionRequest PDA closed.
    const reqAcct = svm.getAccount(redemptionRequestPda)
    if (reqAcct !== null) {
      expect(reqAcct.lamports).toBe(0)
    }

    // 4. Vault ONyc ATA drained back to 0.
    const [vaultAuthority] = findOnreRedemptionVaultAuthorityPda()
    const vaultAta = getAssociatedTokenAddressSync(onycMint.publicKey, vaultAuthority, true)
    const vaultBal = new DataView(
      svm.getAccount(vaultAta)!.data.buffer,
      svm.getAccount(vaultAta)!.data.byteOffset,
    ).getBigUint64(64, true)
    expect(vaultBal).toBe(0n)

    // 5. Relayer's onyc_ata regained the locked NET_ONYC_TO_ONRE. Pre-cancel
    //    balance was 0 (entire net was in OnRe's vault), so post-cancel
    //    balance equals NET_ONYC_TO_ONRE.
    const finalOnycAta = svm.getAccount(onycAta)!
    const finalOnycBal = new DataView(
      finalOnycAta.data.buffer, finalOnycAta.data.byteOffset,
    ).getBigUint64(64, true)
    expect(finalOnycBal).toBe(NET_ONYC_TO_ONRE)
  })
})
