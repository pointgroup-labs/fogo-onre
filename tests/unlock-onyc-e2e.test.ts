/**
 * E2E test for unlock_onyc: exercises the full inbound CPI path through
 * the real NTT program binary in Locking mode (ONyc is canonical on Solana):
 *   1. NTT `redeem`                  — reads a pre-validated TransceiverMessage
 *                                      and writes an InboxItem.
 *   2. NTT `release_inbound_unlock`  — transfers ONyc out of custody to the
 *                                      per-user inbox ATA.
 *   3. unlock_onyc sweeps the recorded amount into relayer custody.
 *
 * Redeem now routes through the OnRe `intent_transfer` fork, so unlock_onyc
 * is a structural mirror of `claim_usdc`: the VTM `sender` is the intent
 * setter PDA (pinned to the {OnRe, Fogo} allowlist), and attribution rides
 * on the NTT `recipient_address` = per-user inbox PDA. `flow.fogo_sender`
 * is the recovered `userWallet`, not the VTM sender.
 *
 * Strategy: we skip the guardian-signed VAA + transceiver `receive_message`
 * dance by injecting a `ValidatedTransceiverMessage` account directly (this
 * is what `receive_message` would write). NTT's `redeem` reads it via
 * `try_deserialize` and enforces the owner matches the registered
 * transceiver — for the OnRe deployment, the transceiver IS the NTT
 * program itself, so we set the owner to `NTT_ONYC_PROGRAM_ID`.
 */

import type { LiteSVM } from 'litesvm'
import {
  findAuthorityPda,
  findInboxItemPda,
  findOutflightFlowPda,
  findTokenAuthorityPda,
  findUserInboxWithMinPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_ONYC_PROGRAM_ID,
  RelayerClient,
} from '@fogo-onre/sdk'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  computeInboxItemHash,
  createAta,
  createMint,
  createMintWithAuthority,
  createProvider,
  createSvm,
  expectError,
  findValidatedTransceiverMessagePda,
  loadAndPatchNttConfig,
  loadAndPatchNttInboxRateLimit,
  loadAndPatchNttOutboxRateLimit,
  loadAndPatchNttPeer,
  readPeerAddress,
  setRegisteredTransceiver,
  setValidatedTransceiverMessage,
} from './utils'

const INTENT_TRANSFER_SETTER_SEED = Buffer.from('intent_transfer')
const FOGO_INTENT_PROGRAM_ID = new PublicKey('Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD')
const ONRE_INTENT_PROGRAM_ID = new PublicKey('inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9')
function intentSetterBytes(programId: PublicKey): Uint8Array {
  return PublicKey.findProgramAddressSync([INTENT_TRANSFER_SETTER_SEED], programId)[0].toBytes()
}

describe('receive (withdraw) e2e (NTT redeem + release_inbound_unlock, Locking mode)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let custodyAta: PublicKey
  let onycAta: PublicKey
  let peerPda: PublicKey

  const CUSTODY_BALANCE = 10_000_000n // 10 ONyc in custody
  const WITHDRAW_MIN = 4_000_000n // user-signed USDC floor, committed in the inbox PDA
  const onreSetter = intentSetterBytes(ONRE_INTENT_PROGRAM_ID)

  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)

    ;[nttTokenAuthorityPda] = findTokenAuthorityPda(NTT_ONYC_PROGRAM_ID)

    baseMint = createMint(svm, authority, 6)
    assetMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)

    client = new RelayerClient(provider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)

    const feeVault = createAta(svm, authority, assetMint.publicKey, authority.publicKey)

    await client.bootstrap().rpc()
    await client
      .initialize({
        authority: authority.publicKey,
        baseMint: baseMint.publicKey,
        assetMint: assetMint.publicKey,
        feeVault,
        depositFeeBps: 50,
        withdrawFeeBps: 100,
      })
      .rpc()

    // Sweep destination — relayer's ONyc ATA (created by `initialize`).
    onycAta = getAssociatedTokenAddressSync(assetMint.publicKey, relayerAuthorityPda, true)

    // Custody ATA owned by NTT token_authority — pre-fund it with ONyc so
    // `release_inbound_unlock` can transfer OUT of it.
    custodyAta = getAssociatedTokenAddressSync(assetMint.publicKey, nttTokenAuthorityPda, true)
    const custodyData = new Uint8Array(165)
    custodyData.set(assetMint.publicKey.toBytes(), 0)
    custodyData.set(nttTokenAuthorityPda.toBytes(), 32)
    new DataView(custodyData.buffer).setBigUint64(64, CUSTODY_BALANCE, true) // amount
    custodyData[108] = 1 // state = Initialized
    svm.setAccount(custodyAta, {
      executable: false,
      owner: TOKEN_PROGRAM_ID,
      lamports: 2_039_280,
      data: custodyData,
      rentEpoch: 0,
    })

    // Patch mint supply to reflect tokens existing in custody
    const mintAcct = svm.getAccount(assetMint.publicKey)!
    const mintData = new Uint8Array(mintAcct.data)
    new DataView(mintData.buffer).setBigUint64(36, CUSTODY_BALANCE, true)
    svm.setAccount(assetMint.publicKey, { ...mintAcct, data: mintData })

    // Load real mainnet NTT account fixtures, relocated to PDAs derived
    // under the ONyc NTT manager program (with bump bytes patched).
    loadAndPatchNttConfig(svm, assetMint.publicKey, custodyAta, NTT_ONYC_PROGRAM_ID)
    peerPda = loadAndPatchNttPeer(svm, NTT_ONYC_PROGRAM_ID)
    loadAndPatchNttInboxRateLimit(svm, NTT_ONYC_PROGRAM_ID)
    loadAndPatchNttOutboxRateLimit(svm, NTT_ONYC_PROGRAM_ID)

    // Register the transceiver (NTT program itself is the transceiver in
    // the OnRe deployment — verified against mainnet on 2026-04-21).
    setRegisteredTransceiver(svm, NTT_ONYC_PROGRAM_ID, 0, NTT_ONYC_PROGRAM_ID)

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  /**
   * Inject a validated transceiver message + return the derived inbox-item
   * PDA. `sender` is the VTM `NttManagerMessage.sender`; `recipient` is the
   * per-user inbox PDA the released ONyc lands in.
   */
  function stageRedeemMessage(sender: Uint8Array, recipient: PublicKey, amount: bigint): {
    inboxItemPda: PublicKey
    validatedMsgPda: PublicKey
  } {
    const peerAddress = readPeerAddress(svm, peerPda)
    const messageId = new Uint8Array(32)
    crypto.getRandomValues(messageId)
    const message = {
      id: messageId,
      sender,
      trimmedAmount: amount,
      trimmedDecimals: 6, // ONyc decimals — scaled back to 6 == amount exact
      sourceToken: new Uint8Array(32).fill(0x22),
      toChain: 1, // Solana
      to: recipient.toBytes(),
    }

    const [validatedMsgPda] = findValidatedTransceiverMessagePda(
      FOGO_WORMHOLE_CHAIN_ID,
      messageId,
      NTT_ONYC_PROGRAM_ID,
    )
    setValidatedTransceiverMessage(svm, validatedMsgPda, NTT_ONYC_PROGRAM_ID, {
      fromChain: FOGO_WORMHOLE_CHAIN_ID,
      sourceNttManager: peerAddress,
      recipientNttManager: NTT_ONYC_PROGRAM_ID.toBytes(),
      message,
    })

    const msgHash = computeInboxItemHash(FOGO_WORMHOLE_CHAIN_ID, message, keccak_256)
    const [inboxItemPda] = findInboxItemPda(msgHash, NTT_ONYC_PROGRAM_ID)
    // Ensure the registered_transceiver PDA exists for the redeem CPI
    setRegisteredTransceiver(svm, NTT_ONYC_PROGRAM_ID, 0, NTT_ONYC_PROGRAM_ID)
    return { inboxItemPda, validatedMsgPda }
  }

  it('releases ONyc to the per-user inbox, sweeps to custody, binds userWallet', async () => {
    const amount = 1_000_000n // 1 ONyc
    const userWallet = Keypair.generate()
    const [userInboxAuthority] = findUserInboxWithMinPda(userWallet.publicKey, WITHDRAW_MIN, client.program.programId)
    // Release lands in the per-user inbox ATA; the sweep moves it to custody.
    createAta(svm, authority, assetMint.publicKey, userInboxAuthority)

    const { inboxItemPda, validatedMsgPda } = stageRedeemMessage(
      onreSetter,
      userInboxAuthority,
      amount,
    )

    try {
      await client
        .receive({
          payer: authority.publicKey,
          direction: { withdraw: {} },
          userWallet: userWallet.publicKey,
          recvMint: assetMint.publicKey,
          minSwapOut: WITHDRAW_MIN,
          nttInboxItem: inboxItemPda,
          nttTransceiverMessage: validatedMsgPda,
          ntt: {
            transceiverAddress: NTT_ONYC_PROGRAM_ID,
          },
        })
        .rpc()
    } catch (e: any) {
      console.log('ERROR:', e.message)
      if (e.logs) {
        console.log('LOGS:', e.logs)
      }
      throw e
    }

    // Outflight flow exists with fogo_sender = userWallet (NOT the setter)
    // and the gross amount swept from NTT custody.
    const [outflightPda] = findOutflightFlowPda(client.configPda, inboxItemPda, client.program.programId)
    const flowAcct = svm.getAccount(outflightPda)
    expect(flowAcct).not.toBeNull()
    const flowData = new Uint8Array(flowAcct!.data)
    // Flow layout: disc(8) + fogo_sender(32) + status(1) + amount(8) + payer(32) + bump(1)
    const recordedFogoSender = flowData.slice(8, 40)
    expect(Buffer.from(recordedFogoSender).equals(userWallet.publicKey.toBuffer())).toBe(true)
    const status = flowData[40]
    expect(status).toBe(0) // FlowStatus.Received (variant 0 in declaration order)
    const recordedAmount = new DataView(flowData.buffer, flowData.byteOffset).getBigUint64(41, true)
    expect(recordedAmount).toBe(amount)

    // ONyc swept into relayer custody ATA.
    const relayerAtaAcct = svm.getAccount(onycAta)!
    const relayerBalance = new DataView(relayerAtaAcct.data.buffer, relayerAtaAcct.data.byteOffset)
      .getBigUint64(64, true)
    expect(relayerBalance).toBe(amount)
  })

  it('accepts the Fogo setter (allowlist member 1)', async () => {
    const amount = 1_000_000n
    const userWallet = Keypair.generate()
    const [userInboxAuthority] = findUserInboxWithMinPda(userWallet.publicKey, WITHDRAW_MIN, client.program.programId)
    createAta(svm, authority, assetMint.publicKey, userInboxAuthority)

    const { inboxItemPda, validatedMsgPda } = stageRedeemMessage(
      intentSetterBytes(FOGO_INTENT_PROGRAM_ID),
      userInboxAuthority,
      amount,
    )

    await client
      .receive({
        payer: authority.publicKey,
        direction: { withdraw: {} },
        userWallet: userWallet.publicKey,
        recvMint: assetMint.publicKey,
        minSwapOut: WITHDRAW_MIN,
        nttInboxItem: inboxItemPda,
        nttTransceiverMessage: validatedMsgPda,
        ntt: { transceiverAddress: NTT_ONYC_PROGRAM_ID },
      })
      .rpc()

    const flow = await client.fetchOutflightFlow(inboxItemPda)
    expect(flow.status).toEqual({ received: {} })
    expect(BigInt(flow.amount.toString())).toBe(amount)
  })

  it('setter pin: rejects a non-setter VTM sender', async () => {
    const amount = 1_000_000n
    const userWallet = Keypair.generate()
    const [userInboxAuthority] = findUserInboxWithMinPda(userWallet.publicKey, WITHDRAW_MIN, client.program.programId)
    createAta(svm, authority, assetMint.publicKey, userInboxAuthority)

    // Stranger sender (a direct, non-intent NTT bridge to the same inbox).
    const { inboxItemPda, validatedMsgPda } = stageRedeemMessage(
      new Uint8Array(32).fill(0x7F),
      userInboxAuthority,
      amount,
    )

    await expectError(
      async () =>
        (await client.receive({
          payer: authority.publicKey,
          direction: { withdraw: {} },
          userWallet: userWallet.publicKey,
          recvMint: assetMint.publicKey,
          minSwapOut: WITHDRAW_MIN,
          nttInboxItem: inboxItemPda,
          nttTransceiverMessage: validatedMsgPda,
          ntt: { transceiverAddress: NTT_ONYC_PROGRAM_ID },
        })).rpc(),
      'UnexpectedFogoSender',
    )
  })
})
