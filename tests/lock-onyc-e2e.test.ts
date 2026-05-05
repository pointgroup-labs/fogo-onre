/**
 * E2E test for lock_onyc: exercises the full CPI path through the real
 * NTT program binary (nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk.so).
 *
 * Uses real mainnet NTT account fixtures, patching the mint, mode
 * (forced to Locking — ONyc is canonical on Solana), and custody fields
 * to match the test's dynamically-created mint.
 */

import type { LiteSVM } from 'litesvm'
import {
  findAuthorityPda,
  findInflightFlowPda,
  findSessionAuthorityPda,
  findTokenAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  nttTransferArgsHash,
  RelayerClient,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import {
  createAta,
  createMint,
  createMintWithAuthority,
  createProvider,
  createSvm,
  FlowStatus,
  loadAndPatchNttConfig,
  loadFixture,
  NTT_INBOX_RL_FIXTURE,
  NTT_OUTBOX_RL_FIXTURE,
  NTT_PEER_FIXTURE,
  pinBinaryFixtures,
  setFlowAccount,
} from './utils'

describe('lock_onyc e2e (NTT transfer_lock)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: Keypair
  let onycMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey

  const fogoSender = new Uint8Array(32).fill(0xAB)

  beforeEach(() => pinBinaryFixtures())
  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    ;[nttTokenAuthorityPda] = findTokenAuthorityPda()

    // Create USDC mint (normal)
    usdcMint = createMint(svm, authority, 6)

    // Create ONyc mint with mint authority = NTT token_authority PDA
    onycMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)

    // External ONyc fee vault — authority-owned ATA, distinct from the
    // relayer's operating ONyc ATA created by `initialize`.
    const feeVault = createAta(svm, authority, onycMint.publicKey, authority.publicKey)

    // Initialize relayer
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

    // Fund relayer's ONyc ATA with balance (mint authority is PDA, so patch directly)
    const onycAta = getAssociatedTokenAddressSync(onycMint.publicKey, relayerAuthorityPda, true)
    const ataAcct = svm.getAccount(onycAta)
    if (!ataAcct) {
      throw new Error('ONyc ATA not found after initialize')
    }
    const ataData = new Uint8Array(ataAcct.data)
    const ataView = new DataView(ataData.buffer, ataData.byteOffset)
    ataView.setBigUint64(64, 1_000_000n, true) // 1 USDC worth
    svm.setAccount(onycAta, { ...ataAcct, data: ataData })

    // Patch ONyc mint supply to match the funded ATA balance
    // SPL Mint layout: mint_authority_option(4) + mint_authority(32) + supply(8@36)
    const mintAcct = svm.getAccount(onycMint.publicKey)
    if (!mintAcct) {
      throw new Error('ONyc mint not found')
    }
    const mintData = new Uint8Array(mintAcct.data)
    const mintView = new DataView(mintData.buffer, mintData.byteOffset)
    mintView.setBigUint64(36, 1_000_000n, true)
    svm.setAccount(onycMint.publicKey, { ...mintAcct, data: mintData })

    // Create custody ATA for NTT token_authority
    const custodyAta = getAssociatedTokenAddressSync(onycMint.publicKey, nttTokenAuthorityPda, true)
    const custodyData = new Uint8Array(165)
    custodyData.set(onycMint.publicKey.toBytes(), 0) // mint
    custodyData.set(nttTokenAuthorityPda.toBytes(), 32) // owner
    custodyData[108] = 1 // state = Initialized
    svm.setAccount(custodyAta, {
      executable: false,
      owner: TOKEN_PROGRAM_ID,
      lamports: 2_039_280,
      data: custodyData,
      rentEpoch: 0,
    })

    // Fund the relayer authority PDA with SOL
    svm.airdrop(relayerAuthorityPda, BigInt(5e9))

    // Load real mainnet NTT account fixtures and patch config
    loadAndPatchNttConfig(svm, onycMint.publicKey, custodyAta)
    loadFixture(svm, NTT_PEER_FIXTURE)
    loadFixture(svm, NTT_INBOX_RL_FIXTURE)
    loadFixture(svm, NTT_OUTBOX_RL_FIXTURE)

    // Patch rate limit timestamps to 0 so they don't fail the
    // `last_tx_timestamp <= now` assertion (mainnet fixtures have future timestamps)
    const outboxRlPda = new PublicKey(NTT_OUTBOX_RL_FIXTURE)
    const outboxRlAcct = svm.getAccount(outboxRlPda)!
    const outboxRlData = new Uint8Array(outboxRlAcct.data)
    // OutboxRateLimit: disc(8) + limit(8) + capacity(8) + last_tx_timestamp(i64@24)
    new DataView(outboxRlData.buffer, outboxRlData.byteOffset).setBigInt64(24, 0n, true)
    svm.setAccount(outboxRlPda, { ...outboxRlAcct, data: outboxRlData })

    const inboxRlPda = new PublicKey(NTT_INBOX_RL_FIXTURE)
    const inboxRlAcct = svm.getAccount(inboxRlPda)!
    const inboxRlData = new Uint8Array(inboxRlAcct.data)
    // InboxRateLimit: disc(8) + bump(1) + limit(8) + capacity(8) + last_tx_timestamp(i64@25)
    new DataView(inboxRlData.buffer, inboxRlData.byteOffset).setBigInt64(25, 0n, true)
    svm.setAccount(inboxRlPda, { ...inboxRlAcct, data: inboxRlData })

    // Ensure token_authority PDA exists (NTT reads it as AccountInfo)
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  it('lock_onyc succeeds with full NTT CPI (transfer_lock)', async () => {
    const nttInboxItem = Keypair.generate()
    const [inflightPda, bump] = findInflightFlowPda(nttInboxItem.publicKey, client.program.programId)

    const amount = 500_000n

    // Inject a Swapped flow
    setFlowAccount(svm, inflightPda, {
      fogoSender,
      status: FlowStatus.Swapped,
      amount,
      payer: authority.publicKey,
      bump,
    }, client.program.programId)

    // Compute session_authority PDA — the SDK uses the same hash internally,
    // we re-derive here only to airdrop SOL to it before the CPI.
    const argsHash = nttTransferArgsHash({
      amount,
      recipientChain: FOGO_WORMHOLE_CHAIN_ID,
      recipientAddress: fogoSender,
      shouldQueue: false,
    })
    const [sessionAuthorityPda] = findSessionAuthorityPda(relayerAuthorityPda, argsHash)

    // Ensure session_authority exists as an account
    svm.airdrop(sessionAuthorityPda, BigInt(1e9))

    // Outbox item is a new account (init)
    const outboxItem = Keypair.generate()

    try {
      await client
        .lockOnyc({
          payer: authority.publicKey,
          onycMint: onycMint.publicKey,
          nttInboxItem: nttInboxItem.publicKey,
          rentDestination: authority.publicKey,
          flowAmount: amount,
          flowFogoSender: fogoSender,
          outboxItem: outboxItem.publicKey,
        })
        .signers([outboxItem])
        .rpc()
    } catch (e: any) {
      console.log('ERROR:', e.message)
      if (e.logs) {
        console.log('LOGS:', e.logs)
      }
      throw e
    }

    // Verify the flow PDA was closed (rent returned)
    const flowAcct = svm.getAccount(inflightPda)
    expect(flowAcct).toBeNull()
  })
})
