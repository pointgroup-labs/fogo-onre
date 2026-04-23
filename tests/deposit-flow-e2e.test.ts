/**
 * E2E test for the full deposit flow: claim_usdc > swap_usdc_to_onyc > lock_onyc.
 *
 * Uses real OnRe, NTT, and Wormhole Token Bridge program binaries with
 * mainnet-captured fixtures (TB Config, MintSigner) plus synthesized TB
 * state accounts for the test's wrapped USDC mint (ForeignEndpoint,
 * WrappedMint, WrappedMeta). The PostedVAA bypasses guardian-signature
 * verification by writing the post-verification account directly.
 */

import {
  findAuthorityPda,
  findInflightFlowPda,
  findSessionAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  GATEWAY_PROGRAM_ID,
  nttTransferArgsHash,
  RelayerClient,
} from '@fogo-onre/sdk'
import {
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { Clock, LiteSVM } from 'litesvm'
import {
  createAta,
  createMintWithAuthority,
  createProvider,
  createSvm,
  createTokenAccount,
  createWrappedMint,
  findOnreMintAuthorityPda,
  findOnrePermissionlessAuthorityPda,
  findOnreVaultAuthorityPda,
  findTokenAuthorityPda,
  loadAndPatchNttConfig,
  loadAndPatchOnreOffer,
  loadFixture,
  NTT_INBOX_RL_FIXTURE,
  NTT_OUTBOX_RL_FIXTURE,
  NTT_PEER_FIXTURE,
  ONRE_BOSS_PUBKEY,
  ONRE_MINT_AUTHORITY_FIXTURE,
  ONRE_PERM_AUTHORITY_FIXTURE,
  ONRE_STATE_FIXTURE,
  ONRE_VAULT_AUTHORITY_FIXTURE,
  setPostedVaa,
  setupForeignEndpoint,
  setupMintAuthority,
  setupTokenBridgeConfig,
  setupWrappedMeta,
} from './utils'

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
  // The deposit fee (50 bps) is now applied POST-swap on the ONyc output
  // inside `swap_usdc_to_onyc`, not on the inbound USDC.
  const expectedNetOnyc = (out: bigint) => (out * (10000n - 50n)) / 10000n

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
    const _onycAta = getAssociatedTokenAddressSync(onycMint.publicKey, relayerAuthorityPda, true)

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

    // Verify Flow PDA exists with status=Claimed and gross amount.
    // (Fees moved to POST-swap on the ONyc output inside swap_usdc_to_onyc;
    // claim_usdc is now a pure pass-through.)
    const gatewayClaim = gatewayClaimPda
    const flowAfterClaim = await client.fetchInflightFlow(gatewayClaim)
    expect(flowAfterClaim.status).toEqual({ claimed: {} })
    expect(BigInt(flowAfterClaim.amount.toString())).toEqual(depositAmount)

    // Verify relayer USDC ATA was funded by the CPI (full gross amount —
    // the deposit fee is taken from the ONyc output during the swap, not
    // from USDC at claim time).
    const usdcAtaAcct = svm.getAccount(usdcAta)!
    const usdcAtaBal = new DataView(
      usdcAtaAcct.data.buffer,
      usdcAtaAcct.data.byteOffset,
    ).getBigUint64(64, true)
    expect(usdcAtaBal).toEqual(depositAmount)

    console.log(`Claim succeeded: ${depositAmount} USDC bridged, recorded as gross on flow`)

    // -------------------------------------------------------------------
    // Step 1: swap_usdc_to_onyc (OnRe CPI). Uses Flow.amount (= depositAmount gross).
    //
    // The SDK assembles OnRe's full 22-entry remainingAccounts list when
    // `onre: {}` is passed (mainnet defaults: state PDA + boss pubkey +
    // derived ATAs all live in `@fogo-onre/sdk`). All vault/perm/boss ATAs
    // referenced inside the list were already seeded into LiteSVM in the
    // top-level `beforeAll`, so no per-test prep is needed here.
    // -------------------------------------------------------------------

    try {
      await client
        .swapUsdcToOnyc({
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          gatewayClaim,
          onre: {},
        })
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
    console.log(`Swap succeeded: ${depositAmount} USDC → ${onycReceived} ONyc (net after deposit fee: ${expectedNetOnyc(onycReceived)})`)

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
