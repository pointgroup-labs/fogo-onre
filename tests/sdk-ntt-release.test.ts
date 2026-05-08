/**
 * Unit tests for `buildNttReleaseWormholeOutboundAccountList`.
 *
 * Locks in the NTT v3 IDL ordering for `releaseWormholeOutbound`
 * (verified against `idl/3_0_0/json/example_native_token_transfers.json`
 * — also matches v2 IDL). The previous version of this test pinned a
 * permuted ordering that swapped indices 3 (transceiver) and 4
 * (wormholeMessage), which produced ConstraintMut on wormhole_message
 * at runtime because Anchor reads its `wormholeMessage` field from the
 * IDL position (4), found a non-writable account there, and rejected.
 *
 * The 6-account composite-flattened wormhole block (bridge / fee_collector /
 * sequence / program / system / clock / rent) starts at index 6.
 * Reordering or losing system/clock/rent silently breaks the CPI.
 */

import {
  buildNttReleaseWormholeOutboundAccountList,
  findNttConfigPda,
  findNttEmitterPda,
  findNttWormholeMessagePda,
  findRegisteredTransceiverPda,
  NTT_ONYC_PROGRAM_ID,
  RelayerClient,
} from '@fogo-onre/sdk'
import { AnchorProvider, Wallet } from '@anchor-lang/core'
import { Connection } from '@solana/web3.js'
import {
  Keypair,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

describe('buildNttReleaseWormholeOutboundAccountList', () => {
  const payer = Keypair.generate().publicKey
  const outboxItem = Keypair.generate().publicKey
  const wormholeProgram = Keypair.generate().publicKey
  const wormholeBridge = Keypair.generate().publicKey
  const wormholeFeeCollector = Keypair.generate().publicKey
  const wormholeSequence = Keypair.generate().publicKey
  const outboxItemSigner = Keypair.generate().publicKey

  const accts = buildNttReleaseWormholeOutboundAccountList({
    payer,
    nttProgramId: NTT_ONYC_PROGRAM_ID,
    outboxItem,
    wormholeProgram,
    wormholeBridge,
    wormholeFeeCollector,
    wormholeSequence,
    outboxItemSigner,
  })

  it('produces exactly 15 accounts', () => {
    expect(accts.length).toBe(15)
  })

  it('matches the NTT v3 IDL pubkey ordering', () => {
    const [configPda] = findNttConfigPda(NTT_ONYC_PROGRAM_ID)
    const [registeredTransceiverPda] = findRegisteredTransceiverPda(
      NTT_ONYC_PROGRAM_ID,
      NTT_ONYC_PROGRAM_ID,
    )
    const [wormholeMessage] = findNttWormholeMessagePda(outboxItem, NTT_ONYC_PROGRAM_ID)
    const [emitter] = findNttEmitterPda(NTT_ONYC_PROGRAM_ID)

    const expected = [
      payer.toBase58(), //  0
      configPda.toBase58(), //  1
      outboxItem.toBase58(), //  2
      registeredTransceiverPda.toBase58(), //  3  transceiver (per IDL)
      wormholeMessage.toBase58(), //  4  wormhole_message (writable)
      emitter.toBase58(), //  5
      wormholeBridge.toBase58(), //  6
      wormholeFeeCollector.toBase58(), //  7
      wormholeSequence.toBase58(), //  8
      wormholeProgram.toBase58(), //  9
      SystemProgram.programId.toBase58(), // 10
      SYSVAR_CLOCK_PUBKEY.toBase58(), // 11
      SYSVAR_RENT_PUBKEY.toBase58(), // 12
      NTT_ONYC_PROGRAM_ID.toBase58(), // 13
      outboxItemSigner.toBase58(), // 14
    ]
    expect(accts.map(a => a.pubkey.toBase58())).toEqual(expected)
  })

  it('marks the writable accounts (mut flags) per the NTT v3 IDL', () => {
    const writable = accts
      .map((a, i) => ({ i, w: a.isWritable }))
      .filter(x => x.w)
      .map(x => x.i)
    // Per NTT v3 IDL: payer, outbox_item, wormhole_message, bridge,
    // fee_collector, sequence are all `mut`. wormhole_message is at
    // index 4 (NOT 3 — that's the non-writable transceiver PDA).
    expect(writable).toEqual([0, 2, 4, 6, 7, 8])
  })

  it('marks only the payer as signer', () => {
    const signers = accts
      .map((a, i) => ({ i, s: a.isSigner }))
      .filter(x => x.s)
      .map(x => x.i)
    expect(signers).toEqual([0])
  })

  it('sysvar Clock & Rent are present at indices 11 and 12 (NOT after the v3 tail)', () => {
    expect(accts[11].pubkey.toBase58()).toBe(SYSVAR_CLOCK_PUBKEY.toBase58())
    expect(accts[12].pubkey.toBase58()).toBe(SYSVAR_RENT_PUBKEY.toBase58())
    // v3 tail (manager, outbox_item_signer) comes AFTER sysvars
    expect(accts[13].pubkey.toBase58()).toBe(NTT_ONYC_PROGRAM_ID.toBase58())
    expect(accts[14].pubkey.toBase58()).toBe(outboxItemSigner.toBase58())
  })

  it('honors caller-supplied wormhole_message and emitter overrides', () => {
    const overrideMessage = Keypair.generate().publicKey
    const overrideEmitter = Keypair.generate().publicKey
    const overridden = buildNttReleaseWormholeOutboundAccountList({
      payer,
      nttProgramId: NTT_ONYC_PROGRAM_ID,
      outboxItem,
      wormholeProgram,
      wormholeBridge,
      wormholeFeeCollector,
      wormholeSequence,
      outboxItemSigner,
      wormholeMessage: overrideMessage,
      emitter: overrideEmitter,
    })
    expect(overridden[4].pubkey.toBase58()).toBe(overrideMessage.toBase58())
    expect(overridden[5].pubkey.toBase58()).toBe(overrideEmitter.toBase58())
  })
})

describe('RelayerClient.lockOnyc encodes transferLockAccountCount=14', () => {
  // Standalone provider; no on-chain calls — we only assert ix encoding.
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed')
  const wallet = new Wallet(Keypair.generate())
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' })
  const client = new RelayerClient(provider as any)

  const onycMint = Keypair.generate().publicKey
  const nttInboxItem = Keypair.generate().publicKey
  const payer = Keypair.generate().publicKey
  const outboxItem = Keypair.generate().publicKey
  const flowFogoSender = new Uint8Array(32).fill(0xAB)

  const release = {
    wormholeProgram: Keypair.generate().publicKey,
    wormholeBridge: Keypair.generate().publicKey,
    wormholeFeeCollector: Keypair.generate().publicKey,
    wormholeSequence: Keypair.generate().publicKey,
    outboxItemSigner: Keypair.generate().publicKey,
  }

  it('appends transferLockAccountCount=14 (one byte) immediately after the 8-byte ix discriminator', async () => {
    const ix = await client
      .lockOnyc({
        payer,
        onycMint,
        nttInboxItem,
        rentDestination: payer,
        flowAmount: 500_000n,
        flowFogoSender,
        outboxItem,
        release,
      })
      .instruction()

    // Anchor encodes args as [8-byte sighash, ...borsh(args)]. The single
    // u8 arg lands at byte 8; LE-irrelevant for u8.
    expect(ix.data.length).toBe(9)
    expect(ix.data[8]).toBe(14)
  })

  it('produces 29 remainingAccounts (14 transfer_lock + 15 release)', async () => {
    const ix = await client
      .lockOnyc({
        payer,
        onycMint,
        nttInboxItem,
        rentDestination: payer,
        flowAmount: 500_000n,
        flowFogoSender,
        outboxItem,
        release,
      })
      .instruction()

    // Anchor's `accounts({...})` populates 9 named accounts; the rest
    // are remaining_accounts. 9 + 29 = 38 total.
    expect(ix.keys.length).toBe(9 + 14 + 15)
  })

  it('throws when release is omitted alongside outboxItem (no lock-only path post-merge)', () => {
    expect(() =>
      client.lockOnyc({
        payer,
        onycMint,
        nttInboxItem,
        rentDestination: payer,
        flowAmount: 500_000n,
        flowFogoSender,
        outboxItem,
      }),
    ).toThrow(/release.*required/i)
  })
})
