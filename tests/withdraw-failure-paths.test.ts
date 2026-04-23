/**
 * Failure-path tests for the withdraw chain. Each test drives the system
 * into a specific pre-condition and asserts the relayer rejects with the
 * expected `RelayerError` (per `programs/relayer/src/error.rs`).
 *
 * Setup boilerplate mirrors `withdraw-flow-e2e.test.ts`. Each test starts
 * from a clean svm (beforeEach) and runs only the legs needed to reach
 * the failure pre-condition.
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
import { Keypair, PublicKey } from '@solana/web3.js'
import { Clock } from 'litesvm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeInboxItemHash,
  createAta,
  createMintWithAuthority,
  createProvider,
  createSvm,
  createWrappedMint,
  expectError,
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

describe('withdraw failure paths', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: { publicKey: PublicKey }
  let onycMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let custodyAta: PublicKey
  let usdcAta: PublicKey
  let inboxItemPda: PublicKey
  let outflightPda: PublicKey

  const ONYC_RELEASED = 1_000_000n
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
      throw new Error(`OnRe binary fixture drift: got ${got}`)
    }
  })

  // Run leg 1 (`unlock_onyc`) so the outflight Flow PDA exists at status
  // `Claimed`. Tests then mutate state before calling leg 2 / leg 3.
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

    // Leg 1: NTT redeem + release_inbound_unlock — outflight Flow at Claimed.
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
    ;[inboxItemPda] = findInboxItemPda(msgHash)

    await client
      .unlockOnyc({
        payer: authority.publicKey,
        onycMint: onycMint.publicKey,
        nttInboxItem: inboxItemPda,
        nttTransceiverMessage: validatedMsgPda,
        ntt: { transceiverAddress: NTT_PROGRAM_ID, custody: custodyAta },
      })
      .rpc()

    ;[outflightPda] = findOutflightFlowPda(inboxItemPda, client.program.programId)
  })

  // Helper: pre-fund USDC ATA so leg 2's snapshot has a baseline.
  function prefundUsdc(amount: bigint) {
    const ataAcct = svm.getAccount(usdcAta)!
    const ataData = new Uint8Array(ataAcct.data)
    new DataView(ataData.buffer, ataData.byteOffset).setBigUint64(64, amount, true)
    svm.setAccount(usdcAta, { ...ataAcct, data: ataData })
  }

  // Helper: synthesize OnRe redemption-side state and return the
  // `RedemptionRequest` PDA the SDK would derive for counter=0.
  function setupOnreState(): { redemptionRequestPda: PublicKey } {
    const { redemptionOffer } = synthesizeOnreRedemptionOffer(
      svm, onycMint.publicKey, usdcMint.publicKey,
    )
    const [redemptionRequestPda] = findOnreRedemptionRequestPda(redemptionOffer, 0n)
    return { redemptionRequestPda }
  }

  function callRequestRedemption(redemptionRequest: PublicKey) {
    return client
      .requestRedemptionOnyc({
        payer: authority.publicKey,
        usdcMint: usdcMint.publicKey,
        onycMint: onycMint.publicKey,
        nttInboxItem: inboxItemPda,
        onre: { redemptionRequest },
      })
      .rpc()
  }

  function callClaimRedemption(redemptionRequest: PublicKey) {
    return client
      .claimRedemptionUsdc({
        cranker: authority.publicKey,
        usdcMint: usdcMint.publicKey,
        nttInboxItem: inboxItemPda,
        redemptionRequest,
        payerForClose: authority.publicKey,
      })
      .rpc()
  }

  it('flowStatusMismatch on requestRedemptionOnyc when flow is RedemptionPending', async () => {
    prefundUsdc(USDC_PRE_BALANCE)
    const { redemptionRequestPda } = setupOnreState()

    // Force the Flow status byte to RedemptionPending (offset 40), bypassing
    // the legitimate path that would also create a singleton tracker.
    {
      const acct = svm.getAccount(outflightPda)!
      const data = new Uint8Array(acct.data)
      data[40] = FlowStatus.RedemptionPending
      svm.setAccount(outflightPda, { ...acct, data })
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
    const acct = svm.getAccount(outflightPda)!
    const data = new Uint8Array(acct.data)
    new DataView(data.buffer, data.byteOffset).setBigUint64(41, 0n, true)
    svm.setAccount(outflightPda, { ...acct, data })

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

    // And the singleton is still present after the second attempt — its
    // existence is what blocks the new init.
    const [trackerPda] = findRedemptionTrackerPda(client.program.programId)
    expect(svm.getAccount(trackerPda)).not.toBeNull()
  })

  it('redemptionTrackerFlowMismatch on claimRedemptionUsdc when tracker.flow is bogus', async () => {
    prefundUsdc(USDC_PRE_BALANCE)
    const { redemptionRequestPda } = setupOnreState()
    await callRequestRedemption(redemptionRequestPda)

    // Tracker layout: disc(8) + flow(32) + redemption_request(32) + ...
    // Overwrite flow at offset 8 with a bogus key.
    const [trackerPda] = findRedemptionTrackerPda(client.program.programId)
    {
      const acct = svm.getAccount(trackerPda)!
      const data = new Uint8Array(acct.data)
      data.set(Keypair.generate().publicKey.toBytes(), 8)
      svm.setAccount(trackerPda, { ...acct, data })
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

    // Pass a different pubkey than tracker.redemption_request.
    const bogus = Keypair.generate().publicKey

    await expectError(
      () => callClaimRedemption(bogus),
      'RedemptionRequestMismatch',
    )
  })
})
