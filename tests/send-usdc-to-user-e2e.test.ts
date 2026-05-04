/**
 * E2E test for `send_usdc_to_user`: exercises the full outbound CPI path
 * through the real NTT program binary in Locking mode on the USDC.s mint:
 *   1. NTT `transfer_lock` — moves USDC.s out of the relayer ATA into NTT
 *                            custody, posts an outbox item, closes the
 *                            outflight Flow PDA.
 *
 * Mirrors `lock-onyc-e2e.test.ts` with USDC.s substituted for ONyc as the
 * NTT-managed mint. Because NTT's Config PDA is a per-program singleton,
 * binding it to USDC.s precludes any ONyc NTT activity in this SVM — so
 * the ONyc mint exists only because `initialize()` requires it.
 */

import type { LiteSVM } from 'litesvm'
import {
  findAuthorityPda,
  findOutflightFlowPda,
  findSessionAuthorityPda,
  findTokenAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  nttTransferArgsHash,
  RelayerClient,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
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

describe('send_usdc_to_user e2e (NTT transfer_lock outbound on USDC.s, Locking mode)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: Keypair
  let onycMint: Keypair
  let relayerAuthorityPda: PublicKey
  let nttTokenAuthorityPda: PublicKey
  let custodyAta: PublicKey
  let usdcAta: PublicKey
  let nttInboxItem: PublicKey
  let outflightFlow: PublicKey

  const fogoSender = new Uint8Array(32).fill(0xCD)
  const sendAmount = 200_000n // 0.2 USDC.s
  const ATA_PRE_BALANCE = sendAmount // exactly the amount being transferred out

  beforeEach(() => pinBinaryFixtures())
  beforeEach(async () => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    ;[nttTokenAuthorityPda] = findTokenAuthorityPda()

    // USDC.s is the NTT-managed mint here — `token_authority` PDA must hold
    // mint authority so `transfer_lock` can move USDC.s into custody.
    usdcMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)
    onycMint = createMint(svm, authority, 6)
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

    usdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, relayerAuthorityPda, true)

    // Custody ATA owned by NTT token_authority — receives the locked USDC.
    custodyAta = getAssociatedTokenAddressSync(usdcMint.publicKey, nttTokenAuthorityPda, true)
    {
      const data = new Uint8Array(165)
      data.set(usdcMint.publicKey.toBytes(), 0)
      data.set(nttTokenAuthorityPda.toBytes(), 32)
      // amount stays 0 — the lock will deposit into it
      data[108] = 1 // state = Initialized
      svm.setAccount(custodyAta, {
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 2_039_280,
        data,
        rentEpoch: 0,
      })
    }

    // Pre-fund relayer USDC ATA + bump mint supply to match.
    {
      const ataAcct = svm.getAccount(usdcAta)!
      const ataData = new Uint8Array(ataAcct.data)
      new DataView(ataData.buffer, ataData.byteOffset).setBigUint64(64, ATA_PRE_BALANCE, true)
      svm.setAccount(usdcAta, { ...ataAcct, data: ataData })

      const mintAcct = svm.getAccount(usdcMint.publicKey)!
      const mintData = new Uint8Array(mintAcct.data)
      new DataView(mintData.buffer, mintData.byteOffset).setBigUint64(36, ATA_PRE_BALANCE, true)
      svm.setAccount(usdcMint.publicKey, { ...mintAcct, data: mintData })
    }

    // Load + patch NTT state fixtures (singleton Config bound to USDC.s).
    loadAndPatchNttConfig(svm, usdcMint.publicKey, custodyAta)
    loadFixture(svm, NTT_PEER_FIXTURE)
    loadFixture(svm, NTT_INBOX_RL_FIXTURE)
    loadFixture(svm, NTT_OUTBOX_RL_FIXTURE)

    // Zero rate-limit timestamps so `last_tx_timestamp <= now` holds.
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

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))
    svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))

    // Synthesize an outflight Flow at status=Swapped — `send_usdc_to_user`
    // reads only `status`, `amount`, `fogo_sender`, `payer`.
    nttInboxItem = Keypair.generate().publicKey
    let bump: number
    ;[outflightFlow, bump] = findOutflightFlowPda(nttInboxItem, client.program.programId)
    setFlowAccount(
      svm,
      outflightFlow,
      {
        fogoSender,
        status: FlowStatus.Swapped,
        amount: sendAmount,
        payer: authority.publicKey,
        bump,
      },
      client.program.programId,
    )
  })

  it('cPIs into NTT transfer_lock, moves USDC into custody, closes flow', async () => {
    // The on-chain handler binds `session_authority` to a hash of the NTT
    // TransferArgs; LiteSVM needs that PDA to exist before the CPI runs.
    const argsHash = nttTransferArgsHash({
      amount: sendAmount,
      recipientChain: FOGO_WORMHOLE_CHAIN_ID,
      recipientAddress: fogoSender,
      shouldQueue: false,
    })
    const [sessionAuthorityPda] = findSessionAuthorityPda(relayerAuthorityPda, argsHash)
    svm.airdrop(sessionAuthorityPda, BigInt(1e9))

    const outboxItem = Keypair.generate()

    try {
      await client
        .sendUsdcToUser({
          payer: authority.publicKey,
          usdcMint: usdcMint.publicKey,
          nttInboxItem,
          rentDestination: authority.publicKey,
          flowAmount: sendAmount,
          flowFogoSender: fogoSender,
          outboxItem: outboxItem.publicKey,
          ntt: { custody: custodyAta },
        })
        .signers([outboxItem])
        .rpc()
    }
    catch (e: any) {
      console.log('SEND ERROR:', e.message)
      if (e.logs) {
        console.log('SEND LOGS:', e.logs)
      }
      throw e
    }

    // Flow PDA closed → rent refunded.
    expect(svm.getAccount(outflightFlow)).toBeNull()

    // Relayer USDC ATA drained.
    {
      const acct = svm.getAccount(usdcAta)!
      const bal = new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true)
      expect(bal).toEqual(0n)
    }

    // Custody ATA received the locked USDC.
    {
      const acct = svm.getAccount(custodyAta)!
      const bal = new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true)
      expect(bal).toEqual(sendAmount)
    }
  })
})
