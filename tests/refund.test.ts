/**
 * Timeout refund guarantee: a stale `Received` flow returns the original token
 * to `flow.recipient` via NTT, then closes. The guards:
 *   - before timeout            → RefundTooEarly
 *   - status != Received (e.g. Swapped) → FlowStatusMismatch
 *   - past timeout on Received  → original-token NTT manager is invoked
 *     (full transfer_lock + release_wormhole_outbound CPI hits Wormhole Core,
 *     which LiteSVM cannot host; we assert the relayer drove the CPI, proving
 *     every relayer-side guard passed).
 */

import {
  findAuthorityPda,
  findOutflightFlowPda,
  findTokenAuthorityPda,
  NTT_ONYC_PROGRAM_ID,
  REFUND_TIMEOUT_SLOTS,
  RelayerClient,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { Clock, LiteSVM } from 'litesvm'
import { beforeEach, describe, it } from 'vitest'
import {
  createAta,
  createMint,
  createMintWithAuthority,
  createProvider,
  createSvm,
  expectError,
  expectFailure,
  failedInProgram,
  FlowStatus,
  loadAndPatchNttConfig,
  loadAndPatchNttInboxRateLimit,
  loadAndPatchNttOutboxRateLimit,
  loadAndPatchNttPeer,
  setFlowAccount,
} from './utils'

const RECEIVED_SLOT = 1_000n

describe('refund (timeout-gated, returns original token)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let feeVault: PublicKey

  const recipient = new Uint8Array(32).fill(7)
  const amount = 500_000n

  // Withdraw flows received ONyc (asset); refund returns ONyc via the ONyc NTT
  // manager. ONyc is canonical on Solana, so set its mint authority to the NTT
  // token_authority (Locking mode) as the lock-onyc rig does.
  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)

    ;[nttTokenAuthorityPda] = findTokenAuthorityPda(NTT_ONYC_PROGRAM_ID)

    baseMint = createMint(svm, authority, 6)
    assetMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)
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

    // Fund relayer ONyc ATA so transfer_lock has the original amount to lock.
    const onycAta = getAssociatedTokenAddressSync(assetMint.publicKey, relayerAuthorityPda, true)
    {
      const acct = svm.getAccount(onycAta)!
      const data = new Uint8Array(acct.data)
      new DataView(data.buffer, data.byteOffset).setBigUint64(64, amount, true)
      svm.setAccount(onycAta, { ...acct, data })
    }

    const custodyAta = getAssociatedTokenAddressSync(assetMint.publicKey, nttTokenAuthorityPda, true)
    {
      const data = new Uint8Array(165)
      data.set(assetMint.publicKey.toBytes(), 0)
      data.set(nttTokenAuthorityPda.toBytes(), 32)
      data[108] = 1
      svm.setAccount(custodyAta, { executable: false, owner: TOKEN_PROGRAM_ID, lamports: 2_039_280, data, rentEpoch: 0 })
    }

    loadAndPatchNttConfig(svm, assetMint.publicKey, custodyAta, NTT_ONYC_PROGRAM_ID)
    loadAndPatchNttPeer(svm, NTT_ONYC_PROGRAM_ID)
    loadAndPatchNttInboxRateLimit(svm, NTT_ONYC_PROGRAM_ID)
    loadAndPatchNttOutboxRateLimit(svm, NTT_ONYC_PROGRAM_ID)
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))
  })

  // Inject a withdraw flow with the chosen status + received_slot.
  function seedWithdrawFlow(nttInboxItem: PublicKey, status: number): PublicKey {
    const [flowPda, bump] = findOutflightFlowPda(client.configPda, nttInboxItem, client.program.programId)
    setFlowAccount(svm, flowPda, {
      recipient,
      status,
      amount,
      payer: authority.publicKey,
      bump,
      direction: 1, // Withdraw
      minSwapOut: 0n,
      receivedSlot: RECEIVED_SLOT,
    }, client.program.programId)
    return flowPda
  }

  function runRefund(nttInboxItem: PublicKey, outboxItem: Keypair) {
    return client
      .refund({
        payer: authority.publicKey,
        direction: { withdraw: {} },
        baseMint: baseMint.publicKey,
        assetMint: assetMint.publicKey,
        nttInboxItem,
        rentDestination: authority.publicKey,
        flowAmount: amount,
        flowRecipient: recipient,
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
  }

  it('reverts before the timeout elapses', async () => {
    const nttInboxItem = Keypair.generate()
    seedWithdrawFlow(nttInboxItem.publicKey, FlowStatus.Received)
    // now = received_slot + TIMEOUT - 1 (one slot short).
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 0n)) // unix unused
    svm.warpToSlot(RECEIVED_SLOT + REFUND_TIMEOUT_SLOTS - 1n)

    await expectError(
      () => runRefund(nttInboxItem.publicKey, Keypair.generate()).rpc(),
      'RefundTooEarly',
    )
  })

  it('reverts a Swapped flow (status guard)', async () => {
    const nttInboxItem = Keypair.generate()
    seedWithdrawFlow(nttInboxItem.publicKey, FlowStatus.Swapped)
    svm.warpToSlot(RECEIVED_SLOT + REFUND_TIMEOUT_SLOTS + 100n) // well past timeout

    await expectError(
      () => runRefund(nttInboxItem.publicKey, Keypair.generate()).rpc(),
      'FlowStatusMismatch',
    )
  })

  it('past timeout on a Received flow drives the original-token NTT send', async () => {
    const nttInboxItem = Keypair.generate()
    seedWithdrawFlow(nttInboxItem.publicKey, FlowStatus.Received)
    svm.warpToSlot(RECEIVED_SLOT + REFUND_TIMEOUT_SLOTS)

    // The full transfer_lock + release_wormhole_outbound CPI needs Wormhole
    // Core (absent in LiteSVM). Reaching the ONyc NTT manager proves every
    // relayer guard (status + timeout) passed and the original-token manager
    // was selected instead of the swap-output manager.
    await expectFailure(
      () => runRefund(nttInboxItem.publicKey, Keypair.generate()).rpc(),
      failedInProgram(NTT_ONYC_PROGRAM_ID),
      'refund reaches the ONyc (original-token) NTT manager CPI',
    )
  })
})
