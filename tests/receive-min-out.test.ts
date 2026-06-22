/**
 * Min-out guarantee: `receive` binds the user-signed floor into
 * `flow.min_swap_out` via the min-bearing inbox PDA. The NTT
 * `recipient_address` commits the value `M`; a permissionless caller that
 * supplies a different `min_swap_out` arg derives a different inbox authority,
 * so `inbox.recipient_address == user_inbox_authority` no longer holds and the
 * call reverts. Honest path stores exactly `M`.
 *
 * Built on the deposit-flow rig (real NTT redeem + release CPI). The forged
 * case feeds the genuine `M`-bound VTM but calls `receive` with `M'`.
 */

import {
  findAuthorityPda,
  findInboxItemPda,
  findIntentTransferSetterPda,
  findTokenAuthorityPda,
  findUserInboxWithMinPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_USDC_PROGRAM_ID,
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

describe('receive binds user-signed min_swap_out (deposit)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let peerPda: PublicKey
  let feeVault: PublicKey

  const fogoSender = findIntentTransferSetterPda()[0].toBytes()
  const depositAmount = 500_000n
  const committedMin = 400_000n // the value bound into the inbox PDA / VTM

  beforeEach(async () => {
    svm = createSvm()
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

    authority = Keypair.generate()
    const provider = createProvider(svm, authority)

    ;[nttTokenAuthorityPda] = findTokenAuthorityPda(NTT_USDC_PROGRAM_ID)

    baseMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)
    assetMint = createMintWithAuthority(svm, authority, authority.publicKey, 6)
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

    // NTT custody pre-funded so release_inbound_unlock can move USDC out.
    const custodyAta = getAssociatedTokenAddressSync(baseMint.publicKey, nttTokenAuthorityPda, true)
    {
      const data = new Uint8Array(165)
      data.set(baseMint.publicKey.toBytes(), 0)
      data.set(nttTokenAuthorityPda.toBytes(), 32)
      new DataView(data.buffer).setBigUint64(64, depositAmount, true)
      data[108] = 1
      svm.setAccount(custodyAta, { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data, rentEpoch: 0 })
    }
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

  // Build the genuine VTM whose recipient = the min-bearing inbox PDA for
  // `committedMin`, fund that inbox ATA, and return the inbox-item PDA.
  function setupCommittedDeposit(userWallet: PublicKey, min: bigint = committedMin): { inboxItemPda: PublicKey, validatedMsgPda: PublicKey } {
    const [committedInbox] = findUserInboxWithMinPda(userWallet, min, client.program.programId)
    createAta(svm, authority, baseMint.publicKey, committedInbox)
    createAta(svm, authority, baseMint.publicKey, relayerAuthorityPda)

    const peerAddress = readPeerAddress(svm, peerPda)
    const messageId = new Uint8Array(32)
    crypto.getRandomValues(messageId)
    const message = {
      id: messageId,
      sender: fogoSender,
      trimmedAmount: depositAmount,
      trimmedDecimals: 6,
      sourceToken: new Uint8Array(32).fill(0x33),
      toChain: 1,
      to: committedInbox.toBytes(),
    }
    const [validatedMsgPda] = findValidatedTransceiverMessagePda(FOGO_WORMHOLE_CHAIN_ID, messageId, NTT_USDC_PROGRAM_ID)
    setValidatedTransceiverMessage(svm, validatedMsgPda, NTT_USDC_PROGRAM_ID, {
      fromChain: FOGO_WORMHOLE_CHAIN_ID,
      sourceNttManager: peerAddress,
      recipientNttManager: NTT_USDC_PROGRAM_ID.toBytes(),
      message,
    })
    const msgHash = computeInboxItemHash(FOGO_WORMHOLE_CHAIN_ID, message, keccak_256)
    const [inboxItemPda] = findInboxItemPda(msgHash, NTT_USDC_PROGRAM_ID)
    return { inboxItemPda, validatedMsgPda }
  }

  it('stores the correct min_swap_out in the flow', async () => {
    const userWallet = Keypair.generate()
    const { inboxItemPda, validatedMsgPda } = setupCommittedDeposit(userWallet.publicKey)

    await client
      .receive({
        payer: authority.publicKey,
        direction: { deposit: {} },
        userWallet: userWallet.publicKey,
        recvMint: baseMint.publicKey,
        minSwapOut: committedMin,
        nttInboxItem: inboxItemPda,
        nttTransceiverMessage: validatedMsgPda,
        ntt: { transceiverAddress: NTT_USDC_PROGRAM_ID },
      })
      .rpc()

    const flow = await client.fetchInflightFlow(inboxItemPda)
    expect(flow.status).toEqual({ received: {} })
    expect(BigInt(flow.amount.toString())).toEqual(depositAmount)
    expect(BigInt(flow.minSwapOut.toString())).toEqual(committedMin)
  })

  it('reverts min_swap_out == 0 (fail closed — no zero floor)', async () => {
    const userWallet = Keypair.generate()
    const { inboxItemPda, validatedMsgPda } = setupCommittedDeposit(userWallet.publicKey, 0n)

    await expectError(
      () =>
        client
          .receive({
            payer: authority.publicKey,
            direction: { deposit: {} },
            userWallet: userWallet.publicKey,
            recvMint: baseMint.publicKey,
            minSwapOut: 0n,
            nttInboxItem: inboxItemPda,
            nttTransceiverMessage: validatedMsgPda,
            ntt: { transceiverAddress: NTT_USDC_PROGRAM_ID },
          })
          .rpc(),
      'ZeroMinSwapOut',
    )
  })

  it('reverts a forged min_swap_out (arg != committed PDA)', async () => {
    // The inbox the user actually funded commits `committedMin`. A
    // permissionless caller submits the genuine `committedMin`-bound inbox
    // accounts but a forged `min_swap_out` arg. The handler re-derives
    // `expected(forged)` and pins `user_inbox_authority == expected` FIRST —
    // so the mismatch fires before any NTT CPI.
    const userWallet = Keypair.generate()
    const [committedInbox] = findUserInboxWithMinPda(
      userWallet.publicKey,
      committedMin,
      client.program.programId,
    )
    const committedInboxAta = createAta(svm, authority, baseMint.publicKey, committedInbox)
    const nttInboxItem = Keypair.generate()
    const messageId = new Uint8Array(32)
    crypto.getRandomValues(messageId)
    const [validatedMsgPda] = findValidatedTransceiverMessagePda(
      FOGO_WORMHOLE_CHAIN_ID,
      messageId,
      NTT_USDC_PROGRAM_ID,
    )
    setValidatedTransceiverMessage(svm, validatedMsgPda, NTT_USDC_PROGRAM_ID, {
      fromChain: FOGO_WORMHOLE_CHAIN_ID,
      sourceNttManager: new Uint8Array(32).fill(0x22),
      recipientNttManager: NTT_USDC_PROGRAM_ID.toBytes(),
      message: {
        id: messageId,
        sender: fogoSender,
        trimmedAmount: depositAmount,
        trimmedDecimals: 6,
        sourceToken: new Uint8Array(32).fill(0x33),
        toChain: 1,
        to: committedInbox.toBytes(),
      },
    })

    const forgedMin = committedMin + 1n
    await expectError(
      () =>
        client
          .receive({
            payer: authority.publicKey,
            direction: { deposit: {} },
            userWallet: userWallet.publicKey,
            recvMint: baseMint.publicKey,
            minSwapOut: forgedMin,
            nttInboxItem: nttInboxItem.publicKey,
            nttTransceiverMessage: validatedMsgPda,
            redeemAccountsLen: 1,
          })
          // Override the SDK's forged-derived inbox with the genuine
          // committedMin-bound accounts the attacker actually controls.
          .accountsPartial({ userInboxAuthority: committedInbox, userInboxAta: committedInboxAta })
          .remainingAccounts([
            { pubkey: NTT_USDC_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: client.authorityPda, isSigner: false, isWritable: false },
          ])
          .rpc(),
      'UserInboxAuthorityMismatch',
    )
  })
})
