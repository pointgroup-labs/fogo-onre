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
  findAuthorityPda,
  findInboxItemPda,
  findInflightFlowPda,
  findTokenAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_PROGRAM_ID,
  RelayerClient,
} from '@fogo-onre/sdk'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { Clock, LiteSVM } from 'litesvm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  computeInboxItemHash,
  createAta,
  createMint,
  createMintWithAuthority,
  createProvider,
  createSvm,
  createTokenAccount,
  findOnreMintAuthorityPda,
  findOnrePermissionlessAuthorityPda,
  findOnreVaultAuthorityPda,
  findValidatedTransceiverMessagePda,
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
  pinBinaryFixtures,
  readPeerAddress,
  setRegisteredTransceiver,
  setValidatedTransceiverMessage,
} from './utils'

describe('deposit flow e2e (claim_usdc → swap_usdc_to_onyc)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: Keypair
  let onycMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey

  let onreVaultAuthorityPda: PublicKey
  let onrePermAuthorityPda: PublicKey
  let onreMintAuthorityPda: PublicKey

  const fogoSender = new Uint8Array(32).fill(0xAB)
  const depositAmount = 500_000n // 0.5 USDC gross
  // ONyc the OnRe vault holds (must be enough for the swap's output)
  const VAULT_ONYC_BALANCE = 10_000_000n

  beforeEach(() => pinBinaryFixtures())
  beforeEach(async () => {
    svm = createSvm()
    // Set clock to 1 hour into the OnRe pricing vector's active period.
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    ;[nttTokenAuthorityPda] = findTokenAuthorityPda()
    ;[onreVaultAuthorityPda] = findOnreVaultAuthorityPda()
    ;[onrePermAuthorityPda] = findOnrePermissionlessAuthorityPda()
    ;[onreMintAuthorityPda] = findOnreMintAuthorityPda()

    // USDC.s is the NTT-managed mint here — `token_authority` PDA must hold
    // mint authority so `release_inbound_unlock` (Locking mode) can move
    // USDC.s out of NTT custody into the relayer ATA.
    usdcMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)

    // ONyc mint authority = OnRe mint_authority PDA (the swap mints ONyc to
    // the relayer ATA from the OnRe vault).
    onycMint = createMintWithAuthority(svm, authority, onreMintAuthorityPda, 6)
    const feeVault = createAta(svm, authority, onycMint.publicKey, authority.publicKey)

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

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))

    // ----- OnRe fixtures -----
    loadFixture(svm, ONRE_STATE_FIXTURE)
    loadFixture(svm, ONRE_VAULT_AUTHORITY_FIXTURE)
    loadFixture(svm, ONRE_PERM_AUTHORITY_FIXTURE)
    loadFixture(svm, ONRE_MINT_AUTHORITY_FIXTURE)
    loadAndPatchOnreOffer(svm, usdcMint.publicKey, onycMint.publicKey)

    const vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, onreVaultAuthorityPda, true)
    const vaultOnycAta = getAssociatedTokenAddressSync(onycMint.publicKey, onreVaultAuthorityPda, true)
    createTokenAccount(svm, vaultUsdcAta, usdcMint.publicKey, onreVaultAuthorityPda, 0n)
    createTokenAccount(svm, vaultOnycAta, onycMint.publicKey, onreVaultAuthorityPda, VAULT_ONYC_BALANCE)

    // Patch ONyc supply to cover vault balance.
    {
      const acct = svm.getAccount(onycMint.publicKey)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer, data.byteOffset).setBigUint64(36, VAULT_ONYC_BALANCE, true)
      svm.setAccount(onycMint.publicKey, { ...acct, data })
    }

    const permUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, onrePermAuthorityPda, true)
    const permOnycAta = getAssociatedTokenAddressSync(onycMint.publicKey, onrePermAuthorityPda, true)
    createTokenAccount(svm, permUsdcAta, usdcMint.publicKey, onrePermAuthorityPda, 0n)
    createTokenAccount(svm, permOnycAta, onycMint.publicKey, onrePermAuthorityPda, 0n)

    const bossUsdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, ONRE_BOSS_PUBKEY, true)
    createTokenAccount(svm, bossUsdcAta, usdcMint.publicKey, ONRE_BOSS_PUBKEY, 0n)
    svm.airdrop(ONRE_BOSS_PUBKEY, BigInt(1e9))

    // ----- NTT fixtures (USDC.s as NTT-managed mint) -----

    // NTT custody ATA — pre-fund with the inbound USDC so
    // `release_inbound_unlock` can move it into the relayer ATA.
    const custodyAta = getAssociatedTokenAddressSync(usdcMint.publicKey, nttTokenAuthorityPda, true)
    {
      const data = new Uint8Array(165)
      data.set(usdcMint.publicKey.toBytes(), 0)
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
      const acct = svm.getAccount(usdcMint.publicKey)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer).setBigUint64(36, depositAmount, true)
      svm.setAccount(usdcMint.publicKey, { ...acct, data })
    }

    loadAndPatchNttConfig(svm, usdcMint.publicKey, custodyAta)
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
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  it('claim_usdc (NTT inbound) → swap_usdc_to_onyc succeeds', async () => {
    const usdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, relayerAuthorityPda, true)

    // Build the inbound NTT message — recipient = relayerAuthorityPda so
    // released USDC lands in the relayer ATA.
    const peerAddress = readPeerAddress(svm)
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

    try {
      await client
        .claimUsdc({
          payer: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          nttInboxItem: inboxItemPda,
          nttTransceiverMessage: validatedMsgPda,
          ntt: {
            transceiverAddress: NTT_PROGRAM_ID,
            custody: getAssociatedTokenAddressSync(usdcMint.publicKey, nttTokenAuthorityPda, true),
          },
        })
        .rpc()
    }
    catch (e: any) {
      console.log('CLAIM ERROR:', e.message)
      if (e.logs) {
        console.log('CLAIM LOGS:', e.logs)
      }
      throw e
    }

    // Leg 1 post-conditions: Flow at Claimed with gross amount; USDC in relayer ATA.
    const flowAfterClaim = await client.fetchInflightFlow(inboxItemPda)
    expect(flowAfterClaim.status).toEqual({ claimed: {} })
    expect(BigInt(flowAfterClaim.amount.toString())).toEqual(depositAmount)

    {
      const acct = svm.getAccount(usdcAta)!
      const bal = new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true)
      expect(bal).toEqual(depositAmount)
    }

    // ----- Leg 2: swap_usdc_to_onyc (real OnRe CPI) -----
    try {
      await client
        .swapUsdcToOnyc({
          usdcMint: usdcMint.publicKey,
          onycMint: onycMint.publicKey,
          nttInboxItem: inboxItemPda,
          onre: {},
        })
        .rpc()
    }
    catch (e: any) {
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
    const [inflightPda] = findInflightFlowPda(inboxItemPda, client.program.programId)
    expect(svm.getAccount(inflightPda)).not.toBeNull()
  })
})
