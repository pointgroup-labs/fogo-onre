/**
 * E2E test for the full deposit flow: claim_usdc → swap_usdc_to_onyc → lock_onyc.
 *
 * Uses real OnRe, NTT, and Wormhole Token Bridge program binaries with
 * mainnet-captured fixtures (TB Config, MintSigner) plus synthesized TB
 * state accounts for the test's wrapped USDC mint (ForeignEndpoint,
 * WrappedMint, WrappedMeta). The PostedVAA bypasses guardian-signature
 * verification by writing the post-verification account directly.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findAuthorityPda,
  findInflightFlowPda,
  findSessionAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  GATEWAY_PROGRAM_ID,
  nttTransferArgsHash,
  ONRE_PROGRAM_ID,
  RelayerClient,
} from '@fogo-onre/sdk'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js'
import { Clock, LiteSVM } from 'litesvm'
import {
  createMint,
  createProvider,
  createSvm,
  createWrappedMint,
  findOnreMintAuthorityPda,
  findOnreOfferPda,
  findOnrePermissionlessAuthorityPda,
  findOnreVaultAuthorityPda,
  findTokenAuthorityPda,
  loadFixture,
  OFFER_TOKEN_IN_MINT_OFFSET,
  OFFER_TOKEN_OUT_MINT_OFFSET,
  ONRE_BOSS_PUBKEY,
  ONRE_MINT_AUTHORITY_FIXTURE,
  ONRE_OFFER_FIXTURE,
  ONRE_PERM_AUTHORITY_FIXTURE,
  ONRE_STATE_FIXTURE,
  ONRE_VAULT_AUTHORITY_FIXTURE,
  setPostedVaa,
  setupForeignEndpoint,
  setupMintAuthority,
  setupTokenBridgeConfig,
  setupWrappedMeta,
} from './utils'

// ---------------------------------------------------------------------------
// NTT fixture addresses (same as lock-onyc-e2e)
// ---------------------------------------------------------------------------

const NTT_CONFIG_FIXTURE = 'BM8Bb4nMdMgWCRMGsX6GNspU2ez8gb8WGjW1tpYjFLN1'
const NTT_PEER_FIXTURE = 'Cnabq7SzA2oqcxn4RGEcNeUS9J1uzptkNvyRmUemgRQ7'
const NTT_INBOX_RL_FIXTURE = '9sLBr3r7VkvwHVm6N3FBRwBj4ogM22bJkocVc2hfhXdR'
const NTT_OUTBOX_RL_FIXTURE = '8TRJb54ydBnVe5QcrU7GhDL6xzm3FdhuPm4BdSJ4J22v'

// NTT Config byte offsets
const CONFIG_MINT_OFFSET = 42
const CONFIG_MODE_OFFSET = 106
const CONFIG_CUSTODY_OFFSET_1 = 128
const CONFIG_CUSTODY_OFFSET_2 = 160

// ---------------------------------------------------------------------------
// Fixtures directory
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/accounts',
)

function readFixtureData(address: string): Uint8Array {
  const filePath = path.join(FIXTURES_DIR, `${address}.json`)
  const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  return new Uint8Array(Buffer.from(json.account.data[0], 'base64'))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Create a raw SPL Token account at a specific address.
 */
function createTokenAccount(
  svm: LiteSVM,
  address: PublicKey,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint = 0n,
): void {
  const data = new Uint8Array(165)
  data.set(mint.toBytes(), 0) // mint
  data.set(owner.toBytes(), 32) // owner
  const view = new DataView(data.buffer, data.byteOffset)
  view.setBigUint64(64, amount, true) // amount
  data[108] = 1 // state = Initialized
  svm.setAccount(address, {
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports: 2_039_280,
    data,
    rentEpoch: 0,
  })
}

/**
 * Load OnRe offer fixture, patch mint fields, and place at the PDA
 * derived from the test mints.
 */
function loadAndPatchOnreOffer(
  svm: LiteSVM,
  testUsdcMint: PublicKey,
  testOnycMint: PublicKey,
): PublicKey {
  // Read the raw mainnet fixture data
  const data = readFixtureData(ONRE_OFFER_FIXTURE)

  // Patch token_in_mint and token_out_mint to test mints
  data.set(testUsdcMint.toBytes(), OFFER_TOKEN_IN_MINT_OFFSET)
  data.set(testOnycMint.toBytes(), OFFER_TOKEN_OUT_MINT_OFFSET)

  // Patch the last pricing vector (at offset 152) to have a very long duration
  // so it's active at the test's clock time.
  // Vector layout (40 bytes): start_time(8) + effective_start(8) + base_price(8) + apr(8) + duration(8)
  // Set duration at offset 184 to 10 years (315_360_000 seconds)
  const view = new DataView(data.buffer, data.byteOffset)
  view.setBigUint64(184, 315_360_000n, true)

  // Derive the new offer PDA from test mints
  const [offerPda] = findOnreOfferPda(testUsdcMint, testOnycMint)

  svm.setAccount(offerPda, {
    executable: false,
    owner: ONRE_PROGRAM_ID,
    lamports: 5_122_560,
    data,
    rentEpoch: 0,
  })

  return offerPda
}

/**
 * Load and patch NTT config fixture (same as lock-onyc-e2e).
 */
function loadAndPatchNttConfig(
  svm: LiteSVM,
  onycMint: PublicKey,
  custodyAta: PublicKey,
): void {
  loadFixture(svm, NTT_CONFIG_FIXTURE)
  const configPda = new PublicKey(NTT_CONFIG_FIXTURE)
  const acct = svm.getAccount(configPda)!
  const data = new Uint8Array(acct.data)
  data.set(onycMint.toBytes(), CONFIG_MINT_OFFSET)
  data[CONFIG_MODE_OFFSET] = 0 // Locking — ONyc is canonical, locked into custody
  data.set(custodyAta.toBytes(), CONFIG_CUSTODY_OFFSET_1)
  data.set(custodyAta.toBytes(), CONFIG_CUSTODY_OFFSET_2)
  svm.setAccount(configPda, { ...acct, data })
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('deposit flow e2e (claim_usdc → OnRe swap → NTT transfer_burn)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  /** Wrapped mint is a TB PDA (no private key); only `.publicKey` matters. */
  let usdcMint: { publicKey: PublicKey }
  let onycMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey

  // OnRe PDAs (constant — derived from OnRe program ID, not from mints)
  let onreVaultAuthorityPda: PublicKey
  let onrePermAuthorityPda: PublicKey
  let onreMintAuthorityPda: PublicKey

  const fogoSender = new Uint8Array(32).fill(0xAB)
  // Source-chain identity for the wrapped USDC.s mint. These three values
  // must thread together: createWrappedMint, setupWrappedMeta, and the
  // PostedVAA's (token_chain, token_address, emitter_chain, emitter_address)
  // all reference them. TB validates this consistency on the CPI.
  const USDCS_SOURCE_CHAIN = FOGO_WORMHOLE_CHAIN_ID // 51
  const USDCS_TOKEN_ADDR = new Uint8Array(32).fill(0xCC)
  const FOGO_TB_EMITTER = new Uint8Array(32).fill(0xEE)
  const VAA_SEQUENCE = 1n

  // Gross USDC amount delivered by the VAA. `claim_usdc` deducts the
  // 50 bps deposit fee and stores the net on the Flow PDA.
  const depositAmount = 500_000n // 0.5 USDC gross
  const expectedNet = depositAmount * (10000n - 50n) / 10000n // 0.4975 USDC

  beforeEach(async () => {
    svm = createSvm()

    // Set clock to 1 hour into the OnRe pricing vector's active period
    // Vector 3 starts at 1773878400 (2026-03-16T16:00:00Z)
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    ;[nttTokenAuthorityPda] = findTokenAuthorityPda()
    ;[onreVaultAuthorityPda] = findOnreVaultAuthorityPda()
    ;[onrePermAuthorityPda] = findOnrePermissionlessAuthorityPda()
    ;[onreMintAuthorityPda] = findOnreMintAuthorityPda()

    // -----------------------------------------------------------------------
    // Wormhole Token Bridge state for `claim_usdc`. The wrapped USDC mint is
    // a TB PDA derived from (USDCS_SOURCE_CHAIN, USDCS_TOKEN_ADDR), with
    // mint_authority = TB MintSigner PDA so the CPI's mint_to succeeds.
    // -----------------------------------------------------------------------
    usdcMint = createWrappedMint(svm, USDCS_SOURCE_CHAIN, USDCS_TOKEN_ADDR, 6)
    setupTokenBridgeConfig(svm)
    setupForeignEndpoint(svm, USDCS_SOURCE_CHAIN, FOGO_TB_EMITTER)
    setupWrappedMeta(svm, usdcMint.publicKey, USDCS_SOURCE_CHAIN, USDCS_TOKEN_ADDR, 6)
    setupMintAuthority(svm)

    // Create ONyc mint with mint authority = OnRe mint_authority PDA.
    // ONyc is the canonical token issued by OnRe. NTT runs in Locking mode
    // on the Solana side, so it does NOT need mint/burn rights — it just
    // moves ONyc into the custody ATA when bridging out.
    onycMint = createMintWithAuthority(svm, authority, onreMintAuthorityPda, 6)

    // Initialize relayer
    await client
      .initialize({
        authority: authority.publicKey,
        usdcMint: usdcMint.publicKey,
        onycMint: onycMint.publicKey,
        depositFeeBps: 50,
        withdrawFeeBps: 100,
      })
      .rpc()

    // NOTE: Relayer USDC ATA is intentionally NOT pre-funded — `claim_usdc`
    // mints into it via the TB CPI. The ATA itself was created by initialize().

    // Fund relayer authority PDA with SOL
    svm.airdrop(relayerAuthorityPda, BigInt(5e9))

    // -----------------------------------------------------------------------
    // OnRe fixtures
    // -----------------------------------------------------------------------

    // Load State fixture (PDA is constant, not mint-dependent)
    loadFixture(svm, ONRE_STATE_FIXTURE)

    // Ensure vault_authority, permissionless_authority, mint_authority exist
    loadFixture(svm, ONRE_VAULT_AUTHORITY_FIXTURE)
    loadFixture(svm, ONRE_PERM_AUTHORITY_FIXTURE)
    loadFixture(svm, ONRE_MINT_AUTHORITY_FIXTURE)

    // Load offer fixture and patch mints to test mints
    loadAndPatchOnreOffer(svm, usdcMint.publicKey, onycMint.publicKey)

    // Create vault ATAs (derived from test mints + vault_authority)
    const vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, onreVaultAuthorityPda, true)
    const vaultOnycAta = getAssociatedTokenAddressSync(onycMint.publicKey, onreVaultAuthorityPda, true)
    createTokenAccount(svm, vaultUsdcAta, usdcMint.publicKey, onreVaultAuthorityPda, 0n)
    // Fund vault with ONyc so the swap can transfer ONyc to user
    createTokenAccount(svm, vaultOnycAta, onycMint.publicKey, onreVaultAuthorityPda, 10_000_000n)

    // Patch ONyc mint supply to include vault balance
    const mintAcct = svm.getAccount(onycMint.publicKey)!
    const mintData = new Uint8Array(mintAcct.data)
    new DataView(mintData.buffer, mintData.byteOffset).setBigUint64(36, 10_000_000n, true)
    svm.setAccount(onycMint.publicKey, { ...mintAcct, data: mintData })

    // Create permissionless ATAs
    const permUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, onrePermAuthorityPda, true)
    const permOnycAta = getAssociatedTokenAddressSync(onycMint.publicKey, onrePermAuthorityPda, true)
    createTokenAccount(svm, permUsdcAta, usdcMint.publicKey, onrePermAuthorityPda, 0n)
    createTokenAccount(svm, permOnycAta, onycMint.publicKey, onrePermAuthorityPda, 0n)

    // Create boss USDC ATA (boss receives token_in fees)
    const bossUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, ONRE_BOSS_PUBKEY, true)
    createTokenAccount(svm, bossUsdcAta, usdcMint.publicKey, ONRE_BOSS_PUBKEY, 0n)

    // Ensure boss account exists
    svm.airdrop(ONRE_BOSS_PUBKEY, BigInt(1e9))

    // -----------------------------------------------------------------------
    // NTT fixtures (same as lock-onyc-e2e)
    // -----------------------------------------------------------------------

    const custodyAta = getAssociatedTokenAddressSync(onycMint.publicKey, nttTokenAuthorityPda, true)
    createTokenAccount(svm, custodyAta, onycMint.publicKey, nttTokenAuthorityPda, 0n)

    loadAndPatchNttConfig(svm, onycMint.publicKey, custodyAta)
    loadFixture(svm, NTT_PEER_FIXTURE)
    loadFixture(svm, NTT_INBOX_RL_FIXTURE)
    loadFixture(svm, NTT_OUTBOX_RL_FIXTURE)

    // Patch rate limit timestamps to 0
    const outboxRlPda = new PublicKey(NTT_OUTBOX_RL_FIXTURE)
    const outboxRlAcct = svm.getAccount(outboxRlPda)!
    const outboxRlData = new Uint8Array(outboxRlAcct.data)
    new DataView(outboxRlData.buffer, outboxRlData.byteOffset).setBigInt64(24, 0n, true)
    svm.setAccount(outboxRlPda, { ...outboxRlAcct, data: outboxRlData })

    const inboxRlPda = new PublicKey(NTT_INBOX_RL_FIXTURE)
    const inboxRlAcct = svm.getAccount(inboxRlPda)!
    const inboxRlData = new Uint8Array(inboxRlAcct.data)
    new DataView(inboxRlData.buffer, inboxRlData.byteOffset).setBigInt64(25, 0n, true)
    svm.setAccount(inboxRlPda, { ...inboxRlAcct, data: inboxRlData })

    // Ensure token_authority PDA exists
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  it('claim_usdc → swap_usdc_to_onyc → lock_onyc succeeds', async () => {
    const usdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, relayerAuthorityPda, true)
    const onycAta = getAssociatedTokenAddressSync(onycMint.publicKey, relayerAuthorityPda, true)

    // -------------------------------------------------------------------
    // Step 0: claim_usdc — Token Bridge CPI mints wrapped USDC into the
    // relayer's ATA and creates the inflight Flow PDA at status=Claimed.
    //
    // The Wormhole Claim PDA lives under the Token Bridge (Gateway) program
    // (it's TB's own replay-protection account) with seeds
    // [emitter_address, emitter_chain BE, sequence BE]. TB validates the
    // gateway_claim address against this derivation inside the CPI, so we
    // can't use a random keypair here.
    // -------------------------------------------------------------------

    const emitterChainBe = Buffer.alloc(2)
    emitterChainBe.writeUInt16BE(USDCS_SOURCE_CHAIN)

    const sequenceBe = Buffer.alloc(8)
    sequenceBe.writeBigUInt64BE(VAA_SEQUENCE)

    const [gatewayClaimPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(FOGO_TB_EMITTER), emitterChainBe, sequenceBe],
      GATEWAY_PROGRAM_ID,
    )

    const vaaKp = Keypair.generate()
    setPostedVaa(svm, vaaKp.publicKey, {
      fogoSender,
      amount: depositAmount,
      tokenAddress: USDCS_TOKEN_ADDR,
      tokenChain: USDCS_SOURCE_CHAIN,
      // TB `CompleteWrappedWithPayload` derives the expected redeemer PDA as
      // `findPda(["redeemer"], vaa.to)` and requires it to equal the redeemer
      // slot we pass. So `vaa.to` must be the RELAYER PROGRAM ID — the
      // owner of the redeemer PDA — not the recipient ATA.
      to: client.program.programId.toBytes(),
      toChain: 1, // Solana
      emitterChain: USDCS_SOURCE_CHAIN,
      emitterAddress: FOGO_TB_EMITTER,
      sequence: VAA_SEQUENCE,
    })

    try {
      await client
        .claimUsdc({
          payer: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          postedVaa: vaaKp.publicKey,
          gatewayClaim: gatewayClaimPda,
          tokenBridge: { wrappedMint: usdcMint.publicKey, foreignEmitter: FOGO_TB_EMITTER },
        })
        .rpc()
    } catch (e: any) {
      console.log('CLAIM ERROR:', e.message)
      if (e.logs) {
        console.log('CLAIM LOGS:', e.logs)
      }
      throw e
    }

    // Verify Flow PDA exists with status=Claimed and net amount.
    const gatewayClaim = gatewayClaimPda
    const flowAfterClaim = await client.fetchInflightFlow(gatewayClaim)
    expect(flowAfterClaim.status).toEqual({ claimed: {} })
    expect(BigInt(flowAfterClaim.amount.toString())).toEqual(expectedNet)

    // Verify relayer USDC ATA was funded by the CPI (gross amount; the fee
    // is implicit via the Flow's `amount = gross - fee` accounting).
    const usdcAtaAcct = svm.getAccount(usdcAta)!
    const usdcAtaBal = new DataView(
      usdcAtaAcct.data.buffer,
      usdcAtaAcct.data.byteOffset,
    ).getBigUint64(64, true)
    expect(usdcAtaBal).toEqual(depositAmount)

    console.log(`Claim succeeded: ${depositAmount} USDC bridged, ${expectedNet} net to flow`)

    // -------------------------------------------------------------------
    // Step 1: swap_usdc_to_onyc (OnRe CPI). Uses Flow.amount (= expectedNet).
    // -------------------------------------------------------------------

    const [offerPda] = findOnreOfferPda(usdcMint.publicKey, onycMint.publicKey)

    const vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, onreVaultAuthorityPda, true)
    const vaultOnycAta = getAssociatedTokenAddressSync(onycMint.publicKey, onreVaultAuthorityPda, true)
    const permUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, onrePermAuthorityPda, true)
    const permOnycAta = getAssociatedTokenAddressSync(onycMint.publicKey, onrePermAuthorityPda, true)
    const bossUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, ONRE_BOSS_PUBKEY, true)

    const onreRemainingAccounts = [
      // 1. offer (mut)
      { pubkey: offerPda, isSigner: false, isWritable: true },
      // 2. state
      { pubkey: new PublicKey(ONRE_STATE_FIXTURE), isSigner: false, isWritable: false },
      // 3. boss
      { pubkey: ONRE_BOSS_PUBKEY, isSigner: false, isWritable: false },
      // 4. vault_authority
      { pubkey: onreVaultAuthorityPda, isSigner: false, isWritable: false },
      // 5. vault_token_in_account (mut)
      { pubkey: vaultUsdcAta, isSigner: false, isWritable: true },
      // 6. vault_token_out_account (mut)
      { pubkey: vaultOnycAta, isSigner: false, isWritable: true },
      // 7. permissionless_authority
      { pubkey: onrePermAuthorityPda, isSigner: false, isWritable: false },
      // 8. permissionless_token_in_account (mut)
      { pubkey: permUsdcAta, isSigner: false, isWritable: true },
      // 9. permissionless_token_out_account (mut)
      { pubkey: permOnycAta, isSigner: false, isWritable: true },
      // 10. token_in_mint (mut)
      { pubkey: usdcMint.publicKey, isSigner: false, isWritable: true },
      // 11. token_in_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      // 12. token_out_mint (mut)
      { pubkey: onycMint.publicKey, isSigner: false, isWritable: true },
      // 13. token_out_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      // 14. user_token_in_account (mut) — relayer USDC ATA
      { pubkey: usdcAta, isSigner: false, isWritable: true },
      // 15. user_token_out_account (init_if_needed) — relayer ONyc ATA
      { pubkey: onycAta, isSigner: false, isWritable: true },
      // 16. boss_token_in_account (mut)
      { pubkey: bossUsdcAta, isSigner: false, isWritable: true },
      // 17. mint_authority
      { pubkey: onreMintAuthorityPda, isSigner: false, isWritable: false },
      // 18. instructions_sysvar
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      // 19. user (signer) — relayer_authority PDA
      { pubkey: relayerAuthorityPda, isSigner: false, isWritable: true },
      // 20. associated_token_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      // 21. system_program
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // OnRe program itself must be in account_infos for CPI
      { pubkey: ONRE_PROGRAM_ID, isSigner: false, isWritable: false },
    ]

    // Debug: verify all OnRe accounts exist
    for (const { pubkey } of onreRemainingAccounts) {
      const acct = svm.getAccount(pubkey)
      if (!acct) {
        console.log(`MISSING OnRe ACCOUNT: ${pubkey.toBase58()}`)
      }
    }

    try {
      await client
        .swapUsdcToOnyc({
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          gatewayClaim,
        })
        .remainingAccounts(onreRemainingAccounts)
        .rpc()
    } catch (e: any) {
      console.log('SWAP ERROR:', e.message)
      if (e.logs) {
        console.log('SWAP LOGS:', e.logs)
      }
      throw e
    }

    // Verify: flow status changed to Swapped, amount > 0
    const flowAfterSwap = await client.fetchInflightFlow(gatewayClaim)
    expect(flowAfterSwap.status).toEqual({ swapped: {} })
    expect(flowAfterSwap.amount.toNumber()).toBeGreaterThan(0)

    const onycReceived = BigInt(flowAfterSwap.amount.toString())
    console.log(`Swap succeeded: ${expectedNet} USDC → ${onycReceived} ONyc`)

    // -------------------------------------------------------------------
    // Step 2: lock_onyc (NTT CPI — SDK builds the 14-account list)
    // -------------------------------------------------------------------

    // The on-chain handler binds `session_authority` to a hash of the NTT
    // TransferArgs; LiteSVM needs that PDA to exist before the CPI runs.
    const argsHash = nttTransferArgsHash({
      amount: onycReceived,
      recipientChain: FOGO_WORMHOLE_CHAIN_ID,
      recipientAddress: fogoSender,
      shouldQueue: false,
    })
    const [sessionAuthorityPda] = findSessionAuthorityPda(relayerAuthorityPda, argsHash)
    svm.airdrop(sessionAuthorityPda, BigInt(1e9))

    const outboxItem = Keypair.generate()
    const custodyAta = getAssociatedTokenAddressSync(onycMint.publicKey, nttTokenAuthorityPda, true)

    try {
      await client
        .lockOnyc({
          payer: authority.publicKey,
          onycMint: onycMint.publicKey,
          gatewayClaim,
          rentDestination: authority.publicKey,
          flowAmount: onycReceived,
          flowFogoSender: fogoSender,
          outboxItem: outboxItem.publicKey,
          ntt: { custody: custodyAta },
        })
        .signers([outboxItem])
        .rpc()
    } catch (e: any) {
      console.log('LOCK ERROR:', e.message)
      if (e.logs) {
        console.log('LOCK LOGS:', e.logs)
      }
      throw e
    }

    // Verify: flow PDA was closed (rent returned to payer)
    const [inflightPda] = findInflightFlowPda(gatewayClaim, client.program.programId)
    const flowAcct = svm.getAccount(inflightPda)
    expect(flowAcct).toBeNull()

    // Verify: custody ATA received the locked ONyc (Locking mode)
    const custodyAcct = svm.getAccount(custodyAta)!
    const custodyBal = new DataView(
      custodyAcct.data.buffer,
      custodyAcct.data.byteOffset,
    ).getBigUint64(64, true)
    expect(custodyBal).toEqual(onycReceived)

    console.log(`Lock succeeded: ${onycReceived} ONyc locked in NTT custody`)
  })
})
