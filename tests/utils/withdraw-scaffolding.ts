/**
 * Shared scaffolding for the four withdraw-chain test files.
 *
 * Centralizes the ~150 lines of identical setup boilerplate:
 *   - OnRe binary sha256 pin
 *   - LiteSVM + clock + relayer initialization
 *   - Wrapped USDC.s mint + ONyc mint + fee vault
 *   - Token Bridge fixtures
 *   - NTT custody pre-fund + ONyc supply bump
 *   - NTT config patch + peer/rate-limit fixtures (with timestamps zeroed)
 *   - OnRe State fixture + airdrops
 *   - Optional leg 1 (`unlock_onyc`) helper for tests that need a pre-claimed flow
 */

import type { LiteSVM } from 'litesvm'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findInboxItemPda,
  findOutflightFlowPda,
  findTokenAuthorityPda,
  findTokenBridgeSenderPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_PROGRAM_ID,
  ONRE_STATE_FIXTURE,
  RelayerClient,
} from '@fogo-onre/sdk'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { Clock } from 'litesvm'
import { loadFixture } from './fixture-loader'
import { createAta, createMintWithAuthority } from './mint'
import { computeInboxItemHash, findValidatedTransceiverMessagePda, loadAndPatchNttConfig, NTT_INBOX_RL_FIXTURE, NTT_OUTBOX_RL_FIXTURE, NTT_PEER_FIXTURE, readPeerAddress, setRegisteredTransceiver, setValidatedTransceiverMessage } from './ntt-accounts'
import { createProvider, createSvm } from './svm'
import {
  createWrappedMint,
  setupForeignEndpoint,
  setupMintAuthority,
  setupTokenBridgeConfig,
  setupWrappedMeta,
} from './wormhole-fixtures'

/** Constants shared by every withdraw-chain test. */
export const WITHDRAW_TEST_CONSTANTS = {
  ONYC_RELEASED: 1_000_000n,
  NET_ONYC_TO_ONRE: 990_000n,
  CUSTODY_BALANCE: 10_000_000n,
  USDC_PRE_BALANCE: 50_000n,
  FOGO_TB_EMITTER: new Uint8Array(32).fill(0xEE),
  USDCS_TOKEN_ADDR: new Uint8Array(32).fill(0xCC),
  fogoSender: new Uint8Array(32).fill(0x7F),
} as const

const ONRE_MAINNET_BINARY_SHA256
  = 'abcea77d935ca5eb512f43a1b3a6241151c2efa74c80b7bd9a600b959f65f7d6'

/**
 * Pre-test guard: assert the OnRe `.so` fixture is byte-identical to the
 * pinned mainnet binary. Call inside `beforeEach`. Drift here means the
 * "real CPI" tests are no longer running against the binary they claim.
 */
export function pinOnreBinaryFixture(): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const so = readFileSync(
    join(here, '../fixtures/programs/onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe.so'),
  )
  const got = createHash('sha256').update(so).digest('hex')
  if (got !== ONRE_MAINNET_BINARY_SHA256) {
    throw new Error(
      `OnRe binary fixture drift: expected sha256=${ONRE_MAINNET_BINARY_SHA256}, got ${got}. `
      + `The withdraw E2E only proves real mainnet behavior when this hash matches. `
      + `Refresh the fixture and update the constant intentionally.`,
    )
  }
}

/** Fully-wired withdraw-chain rig — every account/PDA the tests reference. */
export interface WithdrawRig {
  svm: LiteSVM
  authority: Keypair
  client: RelayerClient
  usdcMint: { publicKey: PublicKey }
  onycMint: Keypair
  relayerAuthorityPda: PublicKey
  nttTokenAuthorityPda: PublicKey
  custodyAta: PublicKey
  onycAta: PublicKey
  usdcAta: PublicKey
}

/**
 * Build the withdraw-chain test rig: SVM + clock + relayer initialized +
 * mints + NTT custody pre-funded + NTT fixtures loaded + rate-limit
 * timestamps zeroed + OnRe State fixture loaded + airdrops.
 */
export async function setupWithdrawRig(): Promise<WithdrawRig> {
  const { CUSTODY_BALANCE, FOGO_TB_EMITTER, USDCS_TOKEN_ADDR } = WITHDRAW_TEST_CONSTANTS

  const svm = createSvm()
  // Core Bridge stamps message.timestamp from the sysvar; any non-zero
  // value works. Same value used in `send-usdc-to-user-e2e.test.ts`.
  svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

  const authority = Keypair.generate()
  const provider = createProvider(svm, authority)
  const client = new RelayerClient(provider as any)

  const [nttTokenAuthorityPda] = findTokenAuthorityPda()

  // `usdc_mint` MUST be the wrapped-USDC TB PDA so leg 4's outbound burn
  // passes TB's "wrapped == derived(meta)" constraint.
  const usdcMint = createWrappedMint(svm, FOGO_WORMHOLE_CHAIN_ID, USDCS_TOKEN_ADDR, 6)
  const onycMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)
  const feeVault = createAta(svm, authority, onycMint.publicKey, authority.publicKey)

  setupTokenBridgeConfig(svm)
  setupForeignEndpoint(svm, FOGO_WORMHOLE_CHAIN_ID, FOGO_TB_EMITTER)
  setupWrappedMeta(svm, usdcMint.publicKey, FOGO_WORMHOLE_CHAIN_ID, USDCS_TOKEN_ADDR, 6)
  setupMintAuthority(svm)

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

  const relayerAuthorityPda = client.authorityPda
  const onycAta = getAssociatedTokenAddressSync(onycMint.publicKey, relayerAuthorityPda, true)
  const usdcAta = getAssociatedTokenAddressSync(usdcMint.publicKey, relayerAuthorityPda, true)

  const custodyAta = getAssociatedTokenAddressSync(onycMint.publicKey, nttTokenAuthorityPda, true)
  {
    const data = new Uint8Array(165)
    data.set(onycMint.publicKey.toBytes(), 0)
    data.set(nttTokenAuthorityPda.toBytes(), 32)
    new DataView(data.buffer).setBigUint64(64, CUSTODY_BALANCE, true)
    data[108] = 1
    svm.setAccount(custodyAta, {
      executable: false,
      owner: TOKEN_PROGRAM_ID,
      lamports: 2_039_280,
      data,
      rentEpoch: 0,
    })
  }
  {
    // Bump ONyc mint supply to match custody balance so SPL doesn't reject
    // the release for impossible accounting.
    const acct = svm.getAccount(onycMint.publicKey)!
    const data = new Uint8Array(acct.data)
    new DataView(data.buffer).setBigUint64(36, CUSTODY_BALANCE, true)
    svm.setAccount(onycMint.publicKey, { ...acct, data })
  }

  loadAndPatchNttConfig(svm, onycMint.publicKey, custodyAta)
  loadFixture(svm, NTT_PEER_FIXTURE)
  loadFixture(svm, NTT_INBOX_RL_FIXTURE)
  loadFixture(svm, NTT_OUTBOX_RL_FIXTURE)
  // Mainnet captures have future ts that fail the `ts <= now` check inside NTT.
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

  // Token Bridge fixtures + synthesized sender PDA — only leg 4 (the
  // happy-path send_usdc_to_user) actually needs these, but loading
  // mainnet TB state into LiteSVM is harmless for tests that skip leg 4.
  loadFixture(svm, '7oPa2PHQdZmjSPqvpZN7MQxnC7Dcf3uL4oLqknGLk2S3')
  loadFixture(svm, 'Gv1KWf8DT1jKv5pKBmGaTmVszqa56Xn8YGx2Pg7i7qAk')
  loadFixture(svm, '2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn')
  loadFixture(svm, '9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy')

  // Required by `create_redemption_request`'s `seeds=[STATE]` constraint
  // and the `!is_killed` check (mainnet capture has is_killed=0).
  loadFixture(svm, ONRE_STATE_FIXTURE)

  {
    const [senderPda] = findTokenBridgeSenderPda(client.program.programId)
    svm.setAccount(senderPda, {
      executable: false,
      owner: SystemProgram.programId,
      lamports: 1_000_000,
      data: new Uint8Array(0),
      rentEpoch: 0,
    })
  }

  svm.airdrop(relayerAuthorityPda, BigInt(5e9))
  svm.airdrop(nttTokenAuthorityPda, BigInt(1e9))

  return {
    svm,
    authority,
    client,
    usdcMint,
    onycMint,
    relayerAuthorityPda,
    nttTokenAuthorityPda,
    custodyAta,
    onycAta,
    usdcAta,
  }
}

/**
 * Run leg 1 of the withdraw chain (NTT redeem + release_inbound_unlock)
 * against the rig. Returns the inboxItemPda + outflightFlow PDA the
 * subsequent legs need.
 */
export async function runUnlockOnycLeg1(rig: WithdrawRig): Promise<{
  inboxItemPda: PublicKey
  outflightPda: PublicKey
  validatedMsgPda: PublicKey
}> {
  const { ONYC_RELEASED, fogoSender } = WITHDRAW_TEST_CONSTANTS
  const { svm, authority, client, onycMint, relayerAuthorityPda, custodyAta } = rig

  const messageId = new Uint8Array(32)
  crypto.getRandomValues(messageId)
  const peerAddress = readPeerAddress(svm)
  const sourceToken = new Uint8Array(32).fill(0x22)

  const message = {
    id: messageId,
    sender: fogoSender,
    trimmedAmount: ONYC_RELEASED,
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

  await client
    .unlockOnyc({
      payer: authority.publicKey,
      onycMint: onycMint.publicKey,
      nttInboxItem: inboxItemPda,
      nttTransceiverMessage: validatedMsgPda,
      ntt: { transceiverAddress: NTT_PROGRAM_ID, custody: custodyAta },
    })
    .rpc()

  const [outflightPda] = findOutflightFlowPda(inboxItemPda, client.program.programId)
  return { inboxItemPda, outflightPda, validatedMsgPda }
}
