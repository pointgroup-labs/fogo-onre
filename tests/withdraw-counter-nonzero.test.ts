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

// Offset of `request_counter` (u64 LE) inside RedemptionOffer.
const REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET = 138

describe('withdraw flow with non-zero request_counter', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: { publicKey: PublicKey }
  let onycMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let custodyAta: PublicKey
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
      throw new Error(`OnRe binary fixture drift: got ${got}`)
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

  it('binds tracker to the counter=42 derivation and increments to 43', async () => {
    // Leg 1
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

    // Leg 2 setup with counter=42
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

    // request_counter incremented 42 → 43
    const offerView = new DataView(
      svm.getAccount(redemptionOffer)!.data.buffer,
      svm.getAccount(redemptionOffer)!.data.byteOffset,
    )
    expect(offerView.getBigUint64(REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET, true)).toBe(43n)

    // OnRe-created RedemptionRequest at the counter=42 derivation
    const reqAcct = svm.getAccount(redemptionRequestPda)!
    expect(reqAcct.lamports).toBeGreaterThan(0)
    expect(reqAcct.owner.toBase58()).toBe(
      new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe').toBase58(),
    )
    const reqView = new DataView(reqAcct.data.buffer, reqAcct.data.byteOffset)
    expect(reqView.getBigUint64(40, true)).toBe(42n) // request_id

    // Tracker bound to the counter=42 PDA (proves the relayer reads the
    // CPI-consumed account, not a caller-supplied alias).
    const tracker = svm.getAccount(redemptionTrackerPda)!
    const trackerRequest = new PublicKey(tracker.data.slice(40, 72))
    expect(trackerRequest.toBase58()).toBe(redemptionRequestPda.toBase58())

    // Flow advanced as in the happy path.
    const [outflightPda] = findOutflightFlowPda(inboxItemPda, client.program.programId)
    const flow = svm.getAccount(outflightPda)!
    expect(flow.data[40]).toBe(FlowStatus.RedemptionPending)
    const recordedAmount = new DataView(flow.data.buffer, flow.data.byteOffset)
      .getBigUint64(41, true)
    expect(recordedAmount).toBe(NET_ONYC_TO_ONRE)
  })
})
