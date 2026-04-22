/**
 * E2E test for unlock_onyc: exercises the full inbound CPI path through
 * the real NTT program binary in Locking mode (ONyc is canonical on Solana):
 *   1. NTT `redeem`                  — reads a pre-validated TransceiverMessage
 *                                      and writes an InboxItem.
 *   2. NTT `release_inbound_unlock`  — transfers ONyc out of custody to the
 *                                      relayer's ATA.
 *
 * Strategy: we skip the guardian-signed VAA + transceiver `receive_message`
 * dance by injecting a `ValidatedTransceiverMessage` account directly (this
 * is what `receive_message` would write). NTT's `redeem` reads it via
 * `try_deserialize` and enforces the owner matches the registered
 * transceiver — for the OnRe deployment, the transceiver IS the NTT
 * program itself, so we set the owner to `NTT_PROGRAM_ID`.
 */

import type { LiteSVM } from 'litesvm'
import {
  findAuthorityPda,
  findInboxItemPda,
  findOutflightFlowPda,
  findTokenAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_PROGRAM_ID,
  RelayerClient,
} from '@fogo-onre/sdk'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  computeInboxItemHash,
  createMint,
  createProvider,
  createSvm,
  findValidatedTransceiverMessagePda,
  loadFixture,
  setRegisteredTransceiver,
  setValidatedTransceiverMessage,
} from './utils'

// Real mainnet NTT fixture addresses (loaded and patched, same as lock-onyc-e2e)
const NTT_CONFIG_FIXTURE = 'BM8Bb4nMdMgWCRMGsX6GNspU2ez8gb8WGjW1tpYjFLN1'
const NTT_PEER_FIXTURE = 'Cnabq7SzA2oqcxn4RGEcNeUS9J1uzptkNvyRmUemgRQ7'
const NTT_INBOX_RL_FIXTURE = '9sLBr3r7VkvwHVm6N3FBRwBj4ogM22bJkocVc2hfhXdR'
const NTT_OUTBOX_RL_FIXTURE = '8TRJb54ydBnVe5QcrU7GhDL6xzm3FdhuPm4BdSJ4J22v'

// NTT Config byte offsets — same as lock-onyc-e2e
const CONFIG_MINT_OFFSET = 42
const CONFIG_MODE_OFFSET = 106
const CONFIG_CUSTODY_OFFSET_1 = 128
const CONFIG_CUSTODY_OFFSET_2 = 160

// NttManagerPeer layout: disc(8) + bump(1) + address([u8;32]@9) + token_decimals(1)
const PEER_ADDRESS_OFFSET = 9

function createMintWithAuthority(
  svm: LiteSVM,
  payer: Keypair,
  mintAuthority: PublicKey,
  decimals = 6,
): Keypair {
  const mint = createMint(svm, payer, decimals)
  const acct = svm.getAccount(mint.publicKey)!
  const data = new Uint8Array(acct.data)
  data.set(mintAuthority.toBytes(), 4)
  svm.setAccount(mint.publicKey, { ...acct, data })
  return mint
}

function loadAndPatchNttConfig(svm: LiteSVM, onycMint: PublicKey, custodyAta: PublicKey): void {
  loadFixture(svm, NTT_CONFIG_FIXTURE)
  const configPda = new PublicKey(NTT_CONFIG_FIXTURE)
  const acct = svm.getAccount(configPda)!
  const data = new Uint8Array(acct.data)
  data.set(onycMint.toBytes(), CONFIG_MINT_OFFSET)
  data[CONFIG_MODE_OFFSET] = 0 // Locking
  data.set(custodyAta.toBytes(), CONFIG_CUSTODY_OFFSET_1)
  data.set(custodyAta.toBytes(), CONFIG_CUSTODY_OFFSET_2)
  svm.setAccount(configPda, { ...acct, data })
}

/** Read the peer's `address` field so our message uses the real source_ntt_manager. */
function readPeerAddress(svm: LiteSVM): Uint8Array {
  const acct = svm.getAccount(new PublicKey(NTT_PEER_FIXTURE))!
  return new Uint8Array(acct.data).slice(PEER_ADDRESS_OFFSET, PEER_ADDRESS_OFFSET + 32)
}

describe('unlock_onyc e2e (NTT redeem + release_inbound_unlock, Locking mode)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: Keypair
  let onycMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let custodyAta: PublicKey
  let onycAta: PublicKey

  const CUSTODY_BALANCE = 10_000_000n // 10 ONyc in custody

  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    ;[nttTokenAuthorityPda] = findTokenAuthorityPda()

    usdcMint = createMint(svm, authority, 6)
    onycMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)

    await client
      .initialize({
        authority: authority.publicKey,
        usdcMint: usdcMint.publicKey,
        onycMint: onycMint.publicKey,
        depositFeeBps: 50,
        withdrawFeeBps: 100,
      })
      .rpc()

    // Relayer's ONyc ATA (created by `initialize`) — recipient of the release
    onycAta = getAssociatedTokenAddressSync(onycMint.publicKey, relayerAuthorityPda, true)

    // Custody ATA owned by NTT token_authority — pre-fund it with ONyc so
    // `release_inbound_unlock` can transfer OUT of it.
    custodyAta = getAssociatedTokenAddressSync(onycMint.publicKey, nttTokenAuthorityPda, true)
    const custodyData = new Uint8Array(165)
    custodyData.set(onycMint.publicKey.toBytes(), 0)
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
    const mintAcct = svm.getAccount(onycMint.publicKey)!
    const mintData = new Uint8Array(mintAcct.data)
    new DataView(mintData.buffer).setBigUint64(36, CUSTODY_BALANCE, true)
    svm.setAccount(onycMint.publicKey, { ...mintAcct, data: mintData })

    // Load + patch NTT state fixtures
    loadAndPatchNttConfig(svm, onycMint.publicKey, custodyAta)
    loadFixture(svm, NTT_PEER_FIXTURE)
    loadFixture(svm, NTT_INBOX_RL_FIXTURE)
    loadFixture(svm, NTT_OUTBOX_RL_FIXTURE)

    // Zero rate-limit timestamps (fixtures have future ts that break `ts <= now`)
    const outboxRlPda = new PublicKey(NTT_OUTBOX_RL_FIXTURE)
    const outboxRlAcct = svm.getAccount(outboxRlPda)!
    const outboxRlData = new Uint8Array(outboxRlAcct.data)
    new DataView(outboxRlData.buffer).setBigInt64(24, 0n, true)
    svm.setAccount(outboxRlPda, { ...outboxRlAcct, data: outboxRlData })

    const inboxRlPda = new PublicKey(NTT_INBOX_RL_FIXTURE)
    const inboxRlAcct = svm.getAccount(inboxRlPda)!
    const inboxRlData = new Uint8Array(inboxRlAcct.data)
    new DataView(inboxRlData.buffer).setBigInt64(25, 0n, true)
    svm.setAccount(inboxRlPda, { ...inboxRlAcct, data: inboxRlData })

    // Register the transceiver (NTT program itself is the transceiver in
    // the OnRe deployment — verified against mainnet on 2026-04-21).
    setRegisteredTransceiver(svm, NTT_PROGRAM_ID, 0)

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  it('unlock_onyc releases ONyc from custody and records an outflight flow', async () => {
    const amount = 1_000_000n // 1 ONyc
    const fogoSender = new Uint8Array(32).fill(0x7F)

    // Build the NTT message. Critical constraints enforced by `redeem`:
    //   - source_ntt_manager == peer.address (read from the fixture)
    //   - recipient_ntt_manager == NTT_PROGRAM_ID
    //   - to_chain == config.chain_id (Solana = 1)
    //   - owner of ValidatedTransceiverMessage == transceiver.transceiver_address
    //
    // We also set `to = relayerAuthorityPda` so the released ONyc lands in
    // the relayer's ATA (recipient ATA authority == inbox_item.recipient_address).
    const peerAddress = readPeerAddress(svm)
    const messageId = new Uint8Array(32)
    crypto.getRandomValues(messageId)
    const sourceToken = new Uint8Array(32).fill(0x22)

    const message = {
      id: messageId,
      sender: fogoSender,
      trimmedAmount: amount,
      trimmedDecimals: 6, // ONyc decimals — scaled back to 6 == amount exact
      sourceToken,
      toChain: 1, // Solana
      to: relayerAuthorityPda.toBytes(),
    }

    // Derive the validated transceiver message PDA — only the owner matters
    // to `redeem` (not the address itself), but using the canonical PDA keeps
    // the test close to how `receive_message` writes it on mainnet.
    const [validatedMsgPda] = findValidatedTransceiverMessagePda(
      FOGO_WORMHOLE_CHAIN_ID,
      messageId,
      NTT_PROGRAM_ID,
    )

    setValidatedTransceiverMessage(svm, validatedMsgPda, NTT_PROGRAM_ID, {
      fromChain: FOGO_WORMHOLE_CHAIN_ID,
      sourceNttManager: peerAddress,
      recipientNttManager: NTT_PROGRAM_ID.toBytes(),
      message,
    })

    // Content-addressed inbox_item PDA
    const msgHash = computeInboxItemHash(FOGO_WORMHOLE_CHAIN_ID, message, keccak_256)
    const [inboxItemPda] = findInboxItemPda(msgHash)

    // Ensure the registered_transceiver PDA exists for the redeem CPI
    setRegisteredTransceiver(svm, NTT_PROGRAM_ID, 0)

    try {
      await client
        .unlockOnyc({
          payer: authority.publicKey,
          onycMint: onycMint.publicKey,
          nttInboxItem: inboxItemPda,
          nttTransceiverMessage: validatedMsgPda,
          ntt: {
            transceiverAddress: NTT_PROGRAM_ID,
            custody: custodyAta,
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

    // Assert: outflight flow PDA exists with correct fogo_sender and net amount
    const [outflightPda] = findOutflightFlowPda(inboxItemPda, client.program.programId)
    const flowAcct = svm.getAccount(outflightPda)
    expect(flowAcct).not.toBeNull()
    const flowData = new Uint8Array(flowAcct!.data)
    // Flow layout: disc(8) + fogo_sender(32) + status(1) + amount(8) + payer(32) + bump(1)
    const recordedFogoSender = flowData.slice(8, 40)
    expect(Buffer.from(recordedFogoSender).equals(Buffer.from(fogoSender))).toBe(true)
    const status = flowData[40]
    expect(status).toBe(0) // FlowStatus.Claimed (variant 0 in declaration order)
    const recordedAmount = new DataView(flowData.buffer, flowData.byteOffset).getBigUint64(41, true)
    // withdraw_fee_bps = 100 → net = amount * 99 / 100
    const expectedNet = (amount * 9900n) / 10_000n
    expect(recordedAmount).toBe(expectedNet)

    // Assert: ONyc landed in relayer's ATA
    const relayerAtaAcct = svm.getAccount(onycAta)!
    const relayerBalance = new DataView(relayerAtaAcct.data.buffer, relayerAtaAcct.data.byteOffset)
      .getBigUint64(64, true)
    expect(relayerBalance).toBe(amount)
  })
})
