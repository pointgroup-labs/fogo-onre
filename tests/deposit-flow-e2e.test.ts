/**
 * E2E test for the deposit flow legs 1-2: claim_usdc → swap_usdc_to_onyc.
 *
 * **Real CPI coverage**:
 *   - leg 1  claim_usdc           — NTT redeem + release_inbound_unlock against
 *                                   the NTT `.so` (Locking mode, USDC.s as the
 *                                   NTT-managed mint)
 *   - leg 2  swap_usdc_to_onyc    — full relayer handler + real OnRe
 *                                   `swap_token_for_onyc` CPI against the OnRe `.so`
 *
 * Leg 3 (`lock_onyc`) lives in `lock-onyc-e2e.test.ts`. It cannot be exercised
 * here because NTT's Config PDA is a per-program singleton, and this rig binds
 * it to USDC.s for leg 1 — leg 3 needs ONyc as the NTT-managed mint instead.
 *
 * The inbound NTT message bypasses the guardian-signed VAA + transceiver
 * `receive_message` dance by injecting a `ValidatedTransceiverMessage` account
 * directly (the post-state `receive_message` would write).
 */

import {
  buildOnreSwapRemainingAccounts,
  findAuthorityPda,
  findInboxItemPda,
  findInflightFlowPda,
  findIntentTransferSetterPda,
  findTokenAuthorityPda,
  findUserInboxWithMinPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_USDC_PROGRAM_ID,
  ONRE_PROGRAM_ID,
  RelayerClient,
} from '@fogo-onre/sdk'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, PublicKey } from '@solana/web3.js'
import { Clock, LiteSVM } from 'litesvm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeInboxItemHash,
  createAta,
  createMintWithAuthority,
  createProvider,
  createSvm,
  createTokenAccount,
  findOnreMintAuthorityPda,
  findOnrePermissionlessAuthorityPda,
  findOnreVaultAuthorityPda,
  findValidatedTransceiverMessagePda,
  loadAndPatchNttConfig,
  loadAndPatchNttInboxRateLimit,
  loadAndPatchNttOutboxRateLimit,
  loadAndPatchNttPeer,
  loadAndPatchOnreOffer,
  loadFixture,
  ONRE_BOSS_PUBKEY,
  ONRE_MINT_AUTHORITY_FIXTURE,
  ONRE_PERM_AUTHORITY_FIXTURE,
  ONRE_STATE_FIXTURE,
  ONRE_VAULT_AUTHORITY_FIXTURE,
  readPeerAddress,
  setRegisteredTransceiver,
  setValidatedTransceiverMessage,
} from './utils'

describe('deposit flow e2e (receive (deposit) → swap_usdc_to_onyc)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let peerPda: PublicKey
  let feeVault: PublicKey

  let onreVaultAuthorityPda: PublicKey
  let onrePermAuthorityPda: PublicKey
  let onreMintAuthorityPda: PublicKey

  // The relayer pins NTT VAA `sender` to the intent_transfer setter PDA, so
  // tests set `sender` to that PDA's bytes; `flow.fogo_sender` comes from `userWallet`.
  const fogoSender = findIntentTransferSetterPda()[0].toBytes()
  // OnRe fork of intent_transfer — its setter PDA is allowlist member 2.
  const ONRE_INTENT_PROGRAM_ID = new PublicKey('inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9')
  const onreSetter = PublicKey.findProgramAddressSync(
    [Buffer.from('intent_transfer')], ONRE_INTENT_PROGRAM_ID,
  )[0].toBytes()
  const depositAmount = 500_000n // 0.5 USDC gross
  // User-signed ONyc floor committed in the inbox PDA. Low enough that the
  // real OnRe take_offer output (net of the deposit fee) clears it.
  const depositMin = 1n
  // ONyc the OnRe vault holds (must be enough for the swap's output)
  const VAULT_ONYC_BALANCE = 10_000_000n

  beforeEach(async () => {
    svm = createSvm()
    // Set clock to 1 hour into the OnRe pricing vector's active period.
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

    authority = Keypair.generate()
    const provider = createProvider(svm, authority)

    ;[nttTokenAuthorityPda] = findTokenAuthorityPda(NTT_USDC_PROGRAM_ID)
    ;[onreVaultAuthorityPda] = findOnreVaultAuthorityPda()
    ;[onrePermAuthorityPda] = findOnrePermissionlessAuthorityPda()
    ;[onreMintAuthorityPda] = findOnreMintAuthorityPda()

    // USDC.s is the NTT-managed mint, so `token_authority` PDA must hold mint
    // authority for `release_inbound_unlock` (Locking mode) to move it out.
    baseMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)

    // ONyc mint authority = OnRe mint_authority PDA (the swap mints ONyc to
    // the relayer ATA from the OnRe vault).
    assetMint = createMintWithAuthority(svm, authority, onreMintAuthorityPda, 6)

    client = new RelayerClient(provider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    feeVault = createAta(svm, authority, assetMint.publicKey, authority.publicKey)

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

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))

    // ----- OnRe fixtures -----
    loadFixture(svm, ONRE_STATE_FIXTURE)
    loadFixture(svm, ONRE_VAULT_AUTHORITY_FIXTURE)
    loadFixture(svm, ONRE_PERM_AUTHORITY_FIXTURE)
    loadFixture(svm, ONRE_MINT_AUTHORITY_FIXTURE)
    // Patch the OnRe Offer fixture — the take_offer CPI reads it (via
    // swapAccounts). The relayer no longer pins it as a NAV oracle.
    loadAndPatchOnreOffer(svm, baseMint.publicKey, assetMint.publicKey)

    const vaultUsdcAta = getAssociatedTokenAddressSync(baseMint.publicKey, onreVaultAuthorityPda, true)
    const vaultOnycAta = getAssociatedTokenAddressSync(assetMint.publicKey, onreVaultAuthorityPda, true)
    createTokenAccount(svm, vaultUsdcAta, baseMint.publicKey, onreVaultAuthorityPda, 0n)
    createTokenAccount(svm, vaultOnycAta, assetMint.publicKey, onreVaultAuthorityPda, VAULT_ONYC_BALANCE)

    // Patch ONyc supply to cover vault balance.
    {
      const acct = svm.getAccount(assetMint.publicKey)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer, data.byteOffset).setBigUint64(36, VAULT_ONYC_BALANCE, true)
      svm.setAccount(assetMint.publicKey, { ...acct, data })
    }

    const permUsdcAta = getAssociatedTokenAddressSync(baseMint.publicKey, onrePermAuthorityPda, true)
    const permOnycAta = getAssociatedTokenAddressSync(assetMint.publicKey, onrePermAuthorityPda, true)
    createTokenAccount(svm, permUsdcAta, baseMint.publicKey, onrePermAuthorityPda, 0n)
    createTokenAccount(svm, permOnycAta, assetMint.publicKey, onrePermAuthorityPda, 0n)

    const bossUsdcAta = getAssociatedTokenAddressSync(baseMint.publicKey, ONRE_BOSS_PUBKEY, true)
    createTokenAccount(svm, bossUsdcAta, baseMint.publicKey, ONRE_BOSS_PUBKEY, 0n)
    svm.airdrop(ONRE_BOSS_PUBKEY, BigInt(1e9))

    // ----- NTT fixtures (USDC.s as NTT-managed mint) -----

    // NTT custody ATA — pre-fund with the inbound USDC so
    // `release_inbound_unlock` can move it into the relayer ATA.
    const custodyAta = getAssociatedTokenAddressSync(baseMint.publicKey, nttTokenAuthorityPda, true)
    {
      const data = new Uint8Array(165)
      data.set(baseMint.publicKey.toBytes(), 0)
      data.set(nttTokenAuthorityPda.toBytes(), 32)
      new DataView(data.buffer).setBigUint64(64, depositAmount, true)
      data[108] = 1
      svm.setAccount(custodyAta, {
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 2_039_280,
        data,
        rentEpoch: 0,
      })
    }
    // Patch USDC.s mint supply to match custody.
    {
      const acct = svm.getAccount(baseMint.publicKey)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer).setBigUint64(36, depositAmount, true)
      svm.setAccount(baseMint.publicKey, { ...acct, data })
    }

    loadAndPatchNttConfig(svm, baseMint.publicKey, custodyAta, NTT_USDC_PROGRAM_ID)
    peerPda = loadAndPatchNttPeer(svm, NTT_USDC_PROGRAM_ID)
    loadAndPatchNttInboxRateLimit(svm, NTT_USDC_PROGRAM_ID)
    loadAndPatchNttOutboxRateLimit(svm, NTT_USDC_PROGRAM_ID)

    setRegisteredTransceiver(svm, NTT_USDC_PROGRAM_ID, 0, NTT_USDC_PROGRAM_ID)
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  it('receive (deposit) (NTT inbound) → swap_usdc_to_onyc succeeds', async () => {
    const usdcAta = getAssociatedTokenAddressSync(baseMint.publicKey, relayerAuthorityPda, true)

    // The FOGO intent's `recipient_address` is the per-user inbox PDA; NTT
    // releases USDC there and claim_usdc PDA-signs a sweep into custody.
    const userWallet = Keypair.generate()
    const [userInboxAuthority] = findUserInboxWithMinPda(userWallet.publicKey, depositMin, client.program.programId)
    createAta(svm, authority, baseMint.publicKey, userInboxAuthority)
    // Sweep destination must exist so claim_usdc can deserialize it.
    createAta(svm, authority, baseMint.publicKey, relayerAuthorityPda)

    // recipient = userInboxAuthority so released USDC lands in the per-user
    // inbox ATA; the relayer sweeps the per-VAA delta into `usdcAta`.
    const peerAddress = readPeerAddress(svm, peerPda)
    const messageId = new Uint8Array(32)
    crypto.getRandomValues(messageId)
    const sourceToken = new Uint8Array(32).fill(0x33)

    const message = {
      id: messageId,
      sender: fogoSender,
      trimmedAmount: depositAmount,
      trimmedDecimals: 6,
      sourceToken,
      toChain: 1,
      to: userInboxAuthority.toBytes(),
    }

    const [validatedMsgPda] = findValidatedTransceiverMessagePda(
      FOGO_WORMHOLE_CHAIN_ID, messageId, NTT_USDC_PROGRAM_ID,
    )
    setValidatedTransceiverMessage(svm, validatedMsgPda, NTT_USDC_PROGRAM_ID, {
      fromChain: FOGO_WORMHOLE_CHAIN_ID,
      sourceNttManager: peerAddress,
      recipientNttManager: NTT_USDC_PROGRAM_ID.toBytes(),
      message,
    })

    const msgHash = computeInboxItemHash(FOGO_WORMHOLE_CHAIN_ID, message, keccak_256)
    const [inboxItemPda] = findInboxItemPda(msgHash, NTT_USDC_PROGRAM_ID)

    try {
      await client
        .receive({
          payer: authority.publicKey,
          direction: { deposit: {} },
          userWallet: userWallet.publicKey,
          recvMint: baseMint.publicKey,
          minSwapOut: depositMin,
          nttInboxItem: inboxItemPda,
          nttTransceiverMessage: validatedMsgPda,
          ntt: {
            transceiverAddress: NTT_USDC_PROGRAM_ID,
          },
        })
        .rpc()
    } catch (e: any) {
      console.log('CLAIM ERROR:', e.message)
      if (e.logs) {
        console.log('CLAIM LOGS:', e.logs)
      }
      throw e
    }

    // Leg 1 post-conditions: Flow at Received with gross amount; USDC in relayer ATA.
    const flowAfterClaim = await client.fetchInflightFlow(inboxItemPda)
    expect(flowAfterClaim.status).toEqual({ received: {} })
    expect(BigInt(flowAfterClaim.amount.toString())).toEqual(depositAmount)

    {
      const acct = svm.getAccount(usdcAta)!
      const bal = new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true)
      expect(bal).toEqual(depositAmount)
    }

    // ----- Leg 2: swap (unified router-agnostic handler, real OnRe CPI) -----
    const [inflightFlowPda] = findInflightFlowPda(client.configPda, inboxItemPda, client.program.programId)
    const takeOfferData = Buffer.concat([
      Buffer.from([37, 190, 224, 77, 197, 39, 203, 230]),
      (() => {
        const b = Buffer.alloc(8)
        b.writeBigUInt64LE(BigInt(flowAfterClaim.amount.toString()))
        return b
      })(),
      Buffer.from([0]), // approval_message: None
    ])
    const swapAccounts = buildOnreSwapRemainingAccounts({
      tokenInMint: baseMint.publicKey,
      tokenOutMint: assetMint.publicKey,
      userTokenInAccount: getAssociatedTokenAddressSync(baseMint.publicKey, relayerAuthorityPda, true),
      userTokenOutAccount: getAssociatedTokenAddressSync(assetMint.publicKey, relayerAuthorityPda, true),
      user: relayerAuthorityPda,
    })
    try {
      await client
        .swap({
          flowPda: inflightFlowPda,
          baseMint: baseMint.publicKey,
          assetMint: assetMint.publicKey,
          feeVault,
          nttInboxItem: inboxItemPda,
          swapProgram: ONRE_PROGRAM_ID,
          swapDelegate: relayerAuthorityPda,
          swapIxData: takeOfferData,
          swapAccounts,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc()
    } catch (e: any) {
      console.log('SWAP ERROR:', e.message)
      if (e.logs) {
        console.log('SWAP LOGS:', e.logs)
      }
      throw e
    }

    const flowAfterSwap = await client.fetchInflightFlow(inboxItemPda)
    expect(flowAfterSwap.status).toEqual({ swapped: {} })
    expect(flowAfterSwap.amount.toNumber()).toBeGreaterThan(0)

    // The Flow PDA still exists at status=Swapped (closed only by leg 4).
    const [inflightPda] = findInflightFlowPda(client.configPda, inboxItemPda, client.program.programId)
    expect(svm.getAccount(inflightPda)).not.toBeNull()
  })

  it('receive (deposit) accepts the OnRe fork setter (allowlist member 2)', async () => {
    const userWallet = Keypair.generate()
    const [userInboxAuthority] = findUserInboxWithMinPda(userWallet.publicKey, depositMin, client.program.programId)
    createAta(svm, authority, baseMint.publicKey, userInboxAuthority)
    createAta(svm, authority, baseMint.publicKey, relayerAuthorityPda)

    const peerAddress = readPeerAddress(svm, peerPda)
    const messageId = new Uint8Array(32)
    crypto.getRandomValues(messageId)
    const message = {
      id: messageId,
      sender: onreSetter,
      trimmedAmount: depositAmount,
      trimmedDecimals: 6,
      sourceToken: new Uint8Array(32).fill(0x33),
      toChain: 1,
      to: userInboxAuthority.toBytes(),
    }

    const [validatedMsgPda] = findValidatedTransceiverMessagePda(
      FOGO_WORMHOLE_CHAIN_ID, messageId, NTT_USDC_PROGRAM_ID,
    )
    setValidatedTransceiverMessage(svm, validatedMsgPda, NTT_USDC_PROGRAM_ID, {
      fromChain: FOGO_WORMHOLE_CHAIN_ID,
      sourceNttManager: peerAddress,
      recipientNttManager: NTT_USDC_PROGRAM_ID.toBytes(),
      message,
    })

    const msgHash = computeInboxItemHash(FOGO_WORMHOLE_CHAIN_ID, message, keccak_256)
    const [inboxItemPda] = findInboxItemPda(msgHash, NTT_USDC_PROGRAM_ID)

    await client
      .receive({
        payer: authority.publicKey,
        direction: { deposit: {} },
        userWallet: userWallet.publicKey,
        recvMint: baseMint.publicKey,
        minSwapOut: depositMin,
        nttInboxItem: inboxItemPda,
        nttTransceiverMessage: validatedMsgPda,
        ntt: { transceiverAddress: NTT_USDC_PROGRAM_ID },
      })
      .rpc()

    const flow = await client.fetchInflightFlow(inboxItemPda)
    expect(flow.status).toEqual({ received: {} })
    expect(BigInt(flow.amount.toString())).toEqual(depositAmount)
  })
})
