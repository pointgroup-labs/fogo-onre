/**
 * Shared scaffolding for the withdraw-chain test files (legs 1-3).
 *
 * Centralizes the identical setup boilerplate:
 *   - OnRe binary sha256 pin
 *   - LiteSVM + clock + relayer initialization
 *   - USDC.s mint + ONyc mint (NTT-managed) + fee vault
 *   - NTT custody pre-fund + ONyc supply bump
 *   - NTT config patch + peer/rate-limit fixtures (with timestamps zeroed)
 *   - OnRe State fixture + airdrops
 *   - Optional leg 1 (`unlock_onyc`) helper for tests that need a pre-claimed flow
 *
 * Leg 4 (`send_usdc_to_user`) is NOT covered here: NTT's Config PDA is a
 * per-program singleton, and this rig binds it to the ONyc mint for leg 1.
 * USDC.s outbound NTT lives in `send-usdc-to-user-e2e.test.ts` with its
 * own rig that binds the singleton to USDC.s instead.
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
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_PROGRAM_ID,
  ONRE_STATE_FIXTURE,
  RelayerClient,
} from '@fogo-onre/sdk'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Keypair, PublicKey } from '@solana/web3.js'
import { Clock } from 'litesvm'
import { loadFixture } from './fixture-loader'
import { createAta, createMint, createMintWithAuthority } from './mint'
import {
  computeInboxItemHash,
  findValidatedTransceiverMessagePda,
  loadAndPatchNttConfig,
  NTT_INBOX_RL_FIXTURE,
  NTT_OUTBOX_RL_FIXTURE,
  NTT_PEER_FIXTURE,
  readPeerAddress,
  setRegisteredTransceiver,
  setValidatedTransceiverMessage,
} from './ntt-accounts'
import { createProvider, createSvm } from './svm'

/** Constants shared by every withdraw-chain test. */
export const WITHDRAW_TEST_CONSTANTS = {
  ONYC_RELEASED: 1_000_000n,
  NET_ONYC_TO_ONRE: 990_000n,
  CUSTODY_BALANCE: 10_000_000n,
  USDC_PRE_BALANCE: 50_000n,
  fogoSender: new Uint8Array(32).fill(0x7F),
} as const

const ONRE_MAINNET_BINARY_SHA256
  = 'abcea77d935ca5eb512f43a1b3a6241151c2efa74c80b7bd9a600b959f65f7d6'

const NTT_MAINNET_BINARY_SHA256
  = 'f5bb910cde4b99930623c041e315caac4cc2d39afcd034aea8f5097f78cff12d'

/**
 * Pre-test guard: assert the OnRe `.so` fixture is byte-identical to the
 * pinned mainnet binary. Call inside `beforeEach`. Drift here means the
 * "real CPI" tests are no longer running against the binary they claim.
 */
export function pinOnreBinaryFixture(): void {
  assertBinaryFixture(
    'onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe.so',
    ONRE_MAINNET_BINARY_SHA256,
    'OnRe',
  )
}

/**
 * Sister guard for the NTT `.so` fixture. Exists for the same reason as
 * `pinOnreBinaryFixture`: the lock_onyc / unlock / send_usdc CPI tests
 * only prove anything against the *real* mainnet NTT binary; an
 * unintentional swap to a custom build silently invalidates the proof.
 */
export function pinNttBinaryFixture(): void {
  assertBinaryFixture(
    'nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk.so',
    NTT_MAINNET_BINARY_SHA256,
    'NTT',
  )
}

/**
 * Convenience: pin both third-party binary fixtures in one call. Use this
 * in `beforeEach` for any test that CPIs into either OnRe or NTT.
 */
export function pinBinaryFixtures(): void {
  pinOnreBinaryFixture()
  pinNttBinaryFixture()
}

function assertBinaryFixture(filename: string, expectedSha256: string, label: string): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const so = readFileSync(join(here, '../fixtures/programs/', filename))
  const got = createHash('sha256').update(so).digest('hex')
  if (got !== expectedSha256) {
    throw new Error(
      `${label} binary fixture drift: expected sha256=${expectedSha256}, got ${got}. `
      + `The CPI tests only prove real mainnet behavior when this hash matches. `
      + `Refresh the fixture and update the constant intentionally.`,
    )
  }
}

/** Fully-wired withdraw-chain rig — every account/PDA the tests reference. */
export interface WithdrawRig {
  svm: LiteSVM
  authority: Keypair
  client: RelayerClient
  usdcMint: Keypair
  onycMint: Keypair
  relayerAuthorityPda: PublicKey
  nttTokenAuthorityPda: PublicKey
  custodyAta: PublicKey
  onycAta: PublicKey
  usdcAta: PublicKey
}

/**
 * Build the withdraw-chain test rig: SVM + clock + relayer initialized +
 * mints + NTT custody pre-funded (ONyc) + NTT fixtures loaded + rate-limit
 * timestamps zeroed + OnRe State fixture loaded + airdrops.
 */
export async function setupWithdrawRig(): Promise<WithdrawRig> {
  const { CUSTODY_BALANCE } = WITHDRAW_TEST_CONSTANTS

  const svm = createSvm()
  // Non-zero wall clock keeps NTT's `last_tx_timestamp <= now` happy
  // even after we zero the rate-limit timestamps below.
  svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

  const authority = Keypair.generate()
  const provider = createProvider(svm, authority)
  const client = new RelayerClient(provider as any)

  const [nttTokenAuthorityPda] = findTokenAuthorityPda()

  // USDC.s here is just a plain SPL mint — leg 4 (NTT outbound) does not
  // run in this rig. Tests that need real USDC.s NTT outbound use a
  // separate rig that binds NTT Config to USDC.s instead of ONyc.
  const usdcMint = createMint(svm, authority, 6)
  const onycMint = createMintWithAuthority(svm, authority, nttTokenAuthorityPda, 6)
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

  // Required by `create_redemption_request`'s `seeds=[STATE]` constraint
  // and the `!is_killed` check (mainnet capture has is_killed=0).
  loadFixture(svm, ONRE_STATE_FIXTURE)

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
  const { svm, authority, client, onycMint, relayerAuthorityPda } = rig

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
      ntt: { transceiverAddress: NTT_PROGRAM_ID },
    })
    .rpc()

  const [outflightPda] = findOutflightFlowPda(inboxItemPda, client.program.programId)
  return { inboxItemPda, outflightPda, validatedMsgPda }
}
