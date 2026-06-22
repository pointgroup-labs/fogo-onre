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
  NTT_ONYC_PROGRAM_ID,
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
  loadAndPatchNttInboxRateLimit,
  loadAndPatchNttOutboxRateLimit,
  loadAndPatchNttPeer,
  setFlowAccount,
} from './utils'

describe('send (deposit) e2e (NTT transfer_lock)', () => {
  // SKIPPED below (it.skip on the only test): lock_onyc now CPIs into
  // Wormhole Core via the merged release_wormhole_outbound CPI
  // (transfer_lock + release in one ix). LiteSVM cannot host the real
  // Wormhole Core program at the canonical mainnet address without
  // significant fixture work (bridge config, fee_collector, sequence
  // PDAs all under worm2ZoG…), and the upstream wormhole-core .so is
  // not vendored under tests/fixtures/programs/. The 15 release-account
  // positions are validated separately by the unit suite in
  // `sdk-ntt-release.test.ts`. Re-enable once a wormhole-core fixture
  // program is added to the LiteSVM rig.
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey

  const fogoSender = new Uint8Array(32).fill(0xAB)

  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)

    ;[nttTokenAuthorityPda] = findTokenAuthorityPda(NTT_ONYC_PROGRAM_ID)

    // Create USDC mint (normal)
    baseMint = createMint(svm, authority, 6)

    // Create ONyc mint with mint authority = NTT token_authority PDA
    assetMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)

    client = new RelayerClient(provider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)

    // External ONyc fee vault — authority-owned ATA, distinct from the
    // relayer's operating ONyc ATA created by `initialize`.
    const feeVault = createAta(svm, authority, assetMint.publicKey, authority.publicKey)

    // Initialize relayer
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

    // Fund relayer's ONyc ATA with balance (mint authority is PDA, so patch directly)
    const onycAta = getAssociatedTokenAddressSync(assetMint.publicKey, relayerAuthorityPda, true)
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
    const mintAcct = svm.getAccount(assetMint.publicKey)
    if (!mintAcct) {
      throw new Error('ONyc mint not found')
    }
    const mintData = new Uint8Array(mintAcct.data)
    const mintView = new DataView(mintData.buffer, mintData.byteOffset)
    mintView.setBigUint64(36, 1_000_000n, true)
    svm.setAccount(assetMint.publicKey, { ...mintAcct, data: mintData })

    // Create custody ATA for NTT token_authority
    const custodyAta = getAssociatedTokenAddressSync(assetMint.publicKey, nttTokenAuthorityPda, true)
    const custodyData = new Uint8Array(165)
    custodyData.set(assetMint.publicKey.toBytes(), 0) // mint
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

    // Load real mainnet NTT account fixtures, relocated to PDAs derived
    // under the ONyc NTT manager program (with bump bytes patched).
    loadAndPatchNttConfig(svm, assetMint.publicKey, custodyAta, NTT_ONYC_PROGRAM_ID)
    loadAndPatchNttPeer(svm, NTT_ONYC_PROGRAM_ID)
    loadAndPatchNttInboxRateLimit(svm, NTT_ONYC_PROGRAM_ID)
    loadAndPatchNttOutboxRateLimit(svm, NTT_ONYC_PROGRAM_ID)

    // Ensure token_authority PDA exists (NTT reads it as AccountInfo)
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  it.skip('send (deposit) succeeds with full NTT CPI (transfer_lock)', async () => {
    const nttInboxItem = Keypair.generate()
    const [inflightPda, bump] = findInflightFlowPda(client.configPda, nttInboxItem.publicKey, client.program.programId)

    const amount = 500_000n

    // Inject a Swapped flow
    setFlowAccount(svm, inflightPda, {
      recipient: fogoSender,
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
    const [sessionAuthorityPda] = findSessionAuthorityPda(relayerAuthorityPda, argsHash, NTT_ONYC_PROGRAM_ID)

    // Ensure session_authority exists as an account
    svm.airdrop(sessionAuthorityPda, BigInt(1e9))

    // Outbox item is a new account (init)
    const outboxItem = Keypair.generate()

    try {
      await client
        .send({
          payer: authority.publicKey,
          direction: { deposit: {} },
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
          nttInboxItem: nttInboxItem.publicKey,
          rentDestination: authority.publicKey,
          flowAmount: amount,
          flowRecipient: fogoSender,
          outboxItem: outboxItem.publicKey,
          release: {
            wormholeProgram: Keypair.generate().publicKey,
            wormholeBridge: Keypair.generate().publicKey,
            wormholeFeeCollector: Keypair.generate().publicKey,
            wormholeSequence: Keypair.generate().publicKey,
            outboxItemSigner: Keypair.generate().publicKey,
          },
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
