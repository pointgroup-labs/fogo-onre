/**
 * Helpers for constructing NTT (Native Token Transfers) account state
 * programmatically in LiteSVM tests.
 *
 * All structs match the Wormhole NTT program at
 * `nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk`.
 *
 * For ONyc, this program runs in **Locking mode** on Solana (ONyc is
 * canonical here — issued by OnRe). The wrapped representation `ONyc`
 * lives on FOGO and runs in Burning mode there.
 *
 * Reference: https://github.com/wormhole-foundation/native-token-transfers
 */

import type { LiteSVM } from 'litesvm'
import { PublicKey } from '@solana/web3.js'
import { loadFixture } from './fixture-loader'

// ---------------------------------------------------------------------------
// Mainnet NTT fixture addresses (real on-chain accounts cloned into LiteSVM)
// ---------------------------------------------------------------------------

/** NTT Config PDA (seeds=["config"]) */
export const NTT_CONFIG_FIXTURE = 'BM8Bb4nMdMgWCRMGsX6GNspU2ez8gb8WGjW1tpYjFLN1'
/** NTT Peer PDA for FOGO chain 51 (seeds=["peer", chain_id_be]) */
export const NTT_PEER_FIXTURE = 'Cnabq7SzA2oqcxn4RGEcNeUS9J1uzptkNvyRmUemgRQ7'
/** NTT InboxRateLimit PDA for FOGO chain 51 */
export const NTT_INBOX_RL_FIXTURE = '9sLBr3r7VkvwHVm6N3FBRwBj4ogM22bJkocVc2hfhXdR'
/** NTT OutboxRateLimit PDA */
export const NTT_OUTBOX_RL_FIXTURE = '8TRJb54ydBnVe5QcrU7GhDL6xzm3FdhuPm4BdSJ4J22v'

// ---------------------------------------------------------------------------
// NTT Config byte offsets (empirically verified from mainnet fixture)
// ---------------------------------------------------------------------------

/** Offset of the mint pubkey in NTT Config account data */
export const CONFIG_MINT_OFFSET = 42
/** Offset of the mode byte (0=Locking, 1=Burning) */
export const CONFIG_MODE_OFFSET = 106
/** Offset of the first custody pubkey in NTT Config account data */
export const CONFIG_CUSTODY_OFFSET_1 = 128
/** Offset of the second custody pubkey in NTT Config account data */
export const CONFIG_CUSTODY_OFFSET_2 = 160

/**
 * Offset of the peer's `address` field in `NttManagerPeer`. Layout:
 *   disc(8) + bump(1) + address([u8;32]) + token_decimals(1)
 */
export const PEER_ADDRESS_OFFSET = 9

// ---------------------------------------------------------------------------
// Anchor discriminators (sha256("account:<Name>")[..8])
// ---------------------------------------------------------------------------

const CONFIG_DISC = new Uint8Array([0x9B, 0x0C, 0xAA, 0xE0, 0x1E, 0xFA, 0xCC, 0x82])
const NTT_MANAGER_PEER_DISC = new Uint8Array([0x44, 0xAD, 0xB4, 0x60, 0x6C, 0xB6, 0x1B, 0x52])
const REGISTERED_TRANSCEIVER_DISC = new Uint8Array([0xE7, 0x68, 0xB6, 0x60, 0xA8, 0x2B, 0xD8, 0x14])
const INBOX_RATE_LIMIT_DISC = new Uint8Array([0xEF, 0xD0, 0xE8, 0xCA, 0x4A, 0x07, 0xEB, 0xFC])
const OUTBOX_RATE_LIMIT_DISC = new Uint8Array([0x5A, 0x36, 0x00, 0x48, 0x2F, 0xBA, 0x1B, 0x58])
const INBOX_ITEM_DISC = new Uint8Array([0x54, 0x1C, 0x70, 0x61, 0xFB, 0x30, 0xFB, 0x5B])
const OUTBOX_ITEM_DISC = new Uint8Array([0xEA, 0xA8, 0xAA, 0x61, 0xEC, 0xFA, 0xBF, 0x2A])
// Anchor sha256("account:ValidatedTransceiverMessage")[..8]. The wormhole
// transceiver writes one of these per VAA after `receive_message` validates
// it; NTT's `redeem` later reads it (without re-checking signatures).
const VALIDATED_TRANSCEIVER_MESSAGE_DISC = new Uint8Array([
  0x61, 0x00, 0x70, 0x7D, 0x6B, 0xDC, 0x25, 0xB5,
])

// NTT NativeTokenTransfer wire-format prefix (`0x99NTT`) — payload-type
// guard inside `NativeTokenTransfer::Readable::read`.
const NATIVE_TOKEN_TRANSFER_PREFIX = new Uint8Array([0x99, 0x4E, 0x54, 0x54])

// ---------------------------------------------------------------------------
// PDA seed constants (matching NTT source)
// ---------------------------------------------------------------------------

const CONFIG_SEED = Buffer.from('config')
const NTT_MANAGER_PEER_SEED = Buffer.from('peer')
const REGISTERED_TRANSCEIVER_SEED = Buffer.from('registered_transceiver')
const INBOX_RATE_LIMIT_SEED = Buffer.from('inbox_rate_limit')
const OUTBOX_RATE_LIMIT_SEED = Buffer.from('outbox_rate_limit')
const INBOX_ITEM_SEED = Buffer.from('inbox_item')
const TOKEN_AUTHORITY_SEED = Buffer.from('token_authority')
const SESSION_AUTHORITY_SEED = Buffer.from('session_authority')

// ---------------------------------------------------------------------------
// PDA derivations
// ---------------------------------------------------------------------------

export function findNttConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)
}

export function findNttPeerPda(chainId: number, programId: PublicKey): [PublicKey, number] {
  const chainBuf = Buffer.alloc(2)
  chainBuf.writeUInt16BE(chainId)
  return PublicKey.findProgramAddressSync([NTT_MANAGER_PEER_SEED, chainBuf], programId)
}

export function findRegisteredTransceiverPda(
  transceiver: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  // Per upstream: seeds = [REGISTERED_TRANSCEIVER_SEED, transceiver.key()]
  return PublicKey.findProgramAddressSync(
    [REGISTERED_TRANSCEIVER_SEED, transceiver.toBuffer()],
    programId,
  )
}

export function findInboxRateLimitPda(chainId: number, programId: PublicKey): [PublicKey, number] {
  const chainBuf = Buffer.alloc(2)
  chainBuf.writeUInt16BE(chainId)
  return PublicKey.findProgramAddressSync([INBOX_RATE_LIMIT_SEED, chainBuf], programId)
}

export function findOutboxRateLimitPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([OUTBOX_RATE_LIMIT_SEED], programId)
}

export function findTokenAuthorityPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TOKEN_AUTHORITY_SEED], programId)
}

export function findSessionAuthorityPda(
  fromOwner: PublicKey,
  argsHash: Uint8Array,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SESSION_AUTHORITY_SEED, fromOwner.toBuffer(), Buffer.from(argsHash)],
    programId,
  )
}

export function findInboxItemPda(
  messageHash: Uint8Array,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([INBOX_ITEM_SEED, Buffer.from(messageHash)], programId)
}

// ---------------------------------------------------------------------------
// NTT Mode enum
// ---------------------------------------------------------------------------

export const NttMode = {
  Locking: 0,
  Burning: 1,
} as const

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

function writePublicKey(buf: Uint8Array, offset: number, pubkey: PublicKey): number {
  buf.set(pubkey.toBuffer(), offset)
  return offset + 32
}

function writeU8(buf: Uint8Array, offset: number, val: number): number {
  buf[offset] = val
  return offset + 1
}

function writeU16LE(buf: Uint8Array, offset: number, val: number): number {
  const view = new DataView(buf.buffer, buf.byteOffset)
  view.setUint16(offset, val, true)
  return offset + 2
}

function writeU64LE(buf: Uint8Array, offset: number, val: bigint): number {
  const view = new DataView(buf.buffer, buf.byteOffset)
  view.setBigUint64(offset, val, true)
  return offset + 8
}

function writeBool(buf: Uint8Array, offset: number, val: boolean): number {
  buf[offset] = val ? 1 : 0
  return offset + 1
}

// ---------------------------------------------------------------------------
// Account construction
// ---------------------------------------------------------------------------

/**
 * NTT Config account (192 bytes).
 * Layout: disc(8) + bump(1) + owner(32) + pending_owner(Option<Pubkey>=1+32) +
 *         mint(32) + token_program(32) + mode(1) + chain_id(2) +
 *         next_transceiver_id(1) + threshold(1) + enabled_transceivers(Bitmap=8) +
 *         paused(1) + custody(32)
 */
export interface NttConfigData {
  bump: number
  owner: PublicKey
  pendingOwner?: PublicKey | null
  mint: PublicKey
  tokenProgram: PublicKey
  mode: number // 0=Locking, 1=Burning
  chainId: number
  nextTransceiverId: number
  threshold: number
  enabledTransceiversBitmap: bigint // 8-byte bitmap
  paused: boolean
  custody: PublicKey
}

export function serializeNttConfig(config: NttConfigData): Uint8Array {
  const data = new Uint8Array(192)
  let o = 0
  data.set(CONFIG_DISC, o)
  o += 8
  o = writeU8(data, o, config.bump)
  o = writePublicKey(data, o, config.owner)
  // Option<Pubkey>: 1 byte discriminant + 32 bytes if Some
  if (config.pendingOwner) {
    o = writeU8(data, o, 1)
    o = writePublicKey(data, o, config.pendingOwner)
  } else {
    o = writeU8(data, o, 0)
    // 32 zero bytes for None padding
    o += 32
  }
  o = writePublicKey(data, o, config.mint)
  o = writePublicKey(data, o, config.tokenProgram)
  o = writeU8(data, o, config.mode)
  o = writeU16LE(data, o, config.chainId)
  o = writeU8(data, o, config.nextTransceiverId)
  o = writeU8(data, o, config.threshold)
  o = writeU64LE(data, o, config.enabledTransceiversBitmap)
  o = writeBool(data, o, config.paused)
  o = writePublicKey(data, o, config.custody)
  return data
}

/**
 * NttManagerPeer account (42 bytes).
 * Layout: disc(8) + bump(1) + address([u8;32]) + token_decimals(1)
 */
export interface NttManagerPeerData {
  bump: number
  address: Uint8Array // 32 bytes
  tokenDecimals: number
}

export function serializeNttManagerPeer(peer: NttManagerPeerData): Uint8Array {
  const data = new Uint8Array(42)
  let o = 0
  data.set(NTT_MANAGER_PEER_DISC, o)
  o += 8
  o = writeU8(data, o, peer.bump)
  data.set(peer.address, o)
  o += 32
  o = writeU8(data, o, peer.tokenDecimals)
  return data
}

/**
 * RegisteredTransceiver account (42 bytes).
 * Layout: disc(8) + bump(1) + id(1) + transceiver_address(32)
 */
export interface RegisteredTransceiverData {
  bump: number
  id: number
  transceiverAddress: PublicKey
}

export function serializeRegisteredTransceiver(t: RegisteredTransceiverData): Uint8Array {
  const data = new Uint8Array(42)
  let o = 0
  data.set(REGISTERED_TRANSCEIVER_DISC, o)
  o += 8
  o = writeU8(data, o, t.bump)
  o = writeU8(data, o, t.id)
  o = writePublicKey(data, o, t.transceiverAddress)
  return data
}

/**
 * InboxRateLimit account (33 bytes).
 * Layout: disc(8) + bump(1) + rate_limit(RateLimitState=24)
 * RateLimitState: limit(u64) + capacity_at_last_tx(u64) + last_tx_timestamp(i64)
 */
export interface InboxRateLimitData {
  bump: number
  limit: bigint
  capacityAtLastTx: bigint
  lastTxTimestamp: bigint
}

export function serializeInboxRateLimit(r: InboxRateLimitData): Uint8Array {
  const data = new Uint8Array(33)
  let o = 0
  data.set(INBOX_RATE_LIMIT_DISC, o)
  o += 8
  o = writeU8(data, o, r.bump)
  o = writeU64LE(data, o, r.limit)
  o = writeU64LE(data, o, r.capacityAtLastTx)
  o = writeU64LE(data, o, r.lastTxTimestamp)
  return data
}

/**
 * OutboxRateLimit account (32 bytes).
 * Layout: disc(8) + rate_limit(RateLimitState=24)
 */
export interface OutboxRateLimitData {
  limit: bigint
  capacityAtLastTx: bigint
  lastTxTimestamp: bigint
}

export function serializeOutboxRateLimit(r: OutboxRateLimitData): Uint8Array {
  const data = new Uint8Array(32)
  let o = 0
  data.set(OUTBOX_RATE_LIMIT_DISC, o)
  o += 8
  o = writeU64LE(data, o, r.limit)
  o = writeU64LE(data, o, r.capacityAtLastTx)
  o = writeU64LE(data, o, r.lastTxTimestamp)
  return data
}

/**
 * InboxItem account.
 * Layout: disc(8) + init(bool/1) + bump(1) + amount(u64/8) +
 *         recipient_address(32) + votes(Bitmap/8) + release_status(u8/1)
 * Total = 59 bytes
 */
export interface InboxItemData {
  init: boolean
  bump: number
  amount: bigint
  recipientAddress: PublicKey
  votesBitmap: bigint
  releaseStatus: number // 0=NotApproved, 1=ReleaseAfterDelay, 2=Released
}

export const ReleaseStatus = {
  NotApproved: 0,
  ReleaseAfterDelay: 1,
  Released: 2,
} as const

export function serializeInboxItem(item: InboxItemData): Uint8Array {
  const data = new Uint8Array(59)
  let o = 0
  data.set(INBOX_ITEM_DISC, o)
  o += 8
  o = writeBool(data, o, item.init)
  o = writeU8(data, o, item.bump)
  o = writeU64LE(data, o, item.amount)
  o = writePublicKey(data, o, item.recipientAddress)
  o = writeU64LE(data, o, item.votesBitmap)
  o = writeU8(data, o, item.releaseStatus)
  return data
}

/**
 * OutboxItem account.
 * Layout: disc(8) + amount(TrimmedAmount) + sender(32) + recipient_chain(2) +
 *         recipient_ntt_manager(32) + recipient_address(32) + release_timestamp(i64/8) +
 *         released(1)
 * TrimmedAmount = amount(u64/8) + decimals(u8/1) = 9
 * Total = 8 + 9 + 32 + 2 + 32 + 32 + 8 + 1 = 124
 */
export interface OutboxItemData {
  amount: bigint
  decimals: number
  sender: PublicKey
  recipientChain: number
  recipientNttManager: Uint8Array // 32 bytes
  recipientAddress: Uint8Array // 32 bytes
  releaseTimestamp: bigint
  released: boolean
}

export function serializeOutboxItem(item: OutboxItemData): Uint8Array {
  const data = new Uint8Array(124)
  let o = 0
  data.set(OUTBOX_ITEM_DISC, o)
  o += 8
  // TrimmedAmount
  o = writeU64LE(data, o, item.amount)
  o = writeU8(data, o, item.decimals)
  o = writePublicKey(data, o, item.sender)
  o = writeU16LE(data, o, item.recipientChain)
  data.set(item.recipientNttManager, o)
  o += 32
  data.set(item.recipientAddress, o)
  o += 32
  o = writeU64LE(data, o, item.releaseTimestamp)
  o = writeBool(data, o, item.released)
  return data
}

// ---------------------------------------------------------------------------
// High-level injection helpers
// ---------------------------------------------------------------------------

function setNttAccount(
  svm: LiteSVM,
  address: PublicKey,
  data: Uint8Array,
  programId: PublicKey,
): void {
  svm.setAccount(address, {
    executable: false,
    owner: programId,
    lamports: 10_000_000,
    data,
    rentEpoch: 0,
  })
}

/**
 * Inject a full, self-consistent NTT state into LiteSVM for e2e testing.
 * Returns all derived addresses.
 */
export function setupNttState(
  svm: LiteSVM,
  params: {
    assetMint: PublicKey
    tokenProgram: PublicKey
    custodyAccount: PublicKey
    fogoChainId: number // 51
    peerAddress: Uint8Array // 32 bytes - peer NTT manager on FOGO
    transceiverAddress: PublicKey
  },
): {
  configPda: PublicKey
  peerPda: PublicKey
  inboxRateLimitPda: PublicKey
  outboxRateLimitPda: PublicKey
  tokenAuthorityPda: PublicKey
} {
  const [configPda, configBump] = findNttConfigPda()
  const [peerPda, peerBump] = findNttPeerPda(params.fogoChainId)
  const [inboxRateLimitPda, inboxRlBump] = findInboxRateLimitPda(params.fogoChainId)
  const [outboxRateLimitPda] = findOutboxRateLimitPda()
  const [tokenAuthorityPda] = findTokenAuthorityPda()

  const now = BigInt(Math.floor(Date.now() / 1000))

  // Config: Locking mode (ONyc canonical on Solana), chain_id=1, threshold=1
  setNttAccount(svm, configPda, serializeNttConfig({
    bump: configBump,
    owner: PublicKey.default, // doesn't matter for tests
    pendingOwner: null,
    mint: params.assetMint,
    tokenProgram: params.tokenProgram,
    mode: NttMode.Locking,
    chainId: 1, // Solana
    nextTransceiverId: 1,
    threshold: 1,
    enabledTransceiversBitmap: 1n, // bit 0 set
    paused: false,
    custody: params.custodyAccount,
  }))

  // Peer for FOGO chain
  setNttAccount(svm, peerPda, serializeNttManagerPeer({
    bump: peerBump,
    address: params.peerAddress,
    tokenDecimals: 6,
  }))

  // Rate limits (unlimited)
  const UNLIMITED = 0xFFFF_FFFF_FFFF_FFFFn

  setNttAccount(svm, inboxRateLimitPda, serializeInboxRateLimit({
    bump: inboxRlBump,
    limit: UNLIMITED,
    capacityAtLastTx: UNLIMITED,
    lastTxTimestamp: now,
  }))

  setNttAccount(svm, outboxRateLimitPda, serializeOutboxRateLimit({
    limit: UNLIMITED,
    capacityAtLastTx: UNLIMITED,
    lastTxTimestamp: now,
  }))

  return {
    configPda,
    peerPda,
    inboxRateLimitPda,
    outboxRateLimitPda,
    tokenAuthorityPda,
  }
}

// ---------------------------------------------------------------------------
// NTT message serialization (Borsh storage + wire format for keccak hash)
// ---------------------------------------------------------------------------
//
// Two parallel formats matter for inbound redeem:
//
//   * Borsh (Anchor, little-endian) — how `ValidatedTransceiverMessage` is
//     laid out on-chain. The redeem CPI deserializes this account.
//
//   * Wire (big-endian, Wormhole-style with byte prefix and REVERSED
//     TrimmedAmount field order) — used to compute the keccak256 that
//     seeds the `InboxItem` PDA. See upstream:
//       modules/ntt-messages/src/{ntt,ntt_manager,trimmed_amount}.rs
//
// Storage and wire are NOT the same bytes. TrimmedAmount writes decimals
// FIRST in wire but amount FIRST in Borsh. NativeTokenTransfer writes
// `to` before `to_chain` in wire but `to_chain` before `to` in Borsh.

const TRANSCEIVER_MESSAGE_SEED = Buffer.from('transceiver_message')

/** Shape of the Wormhole NTT `NttManagerMessage<NativeTokenTransfer<EmptyPayload>>`. */
export interface NttManagerMessageParams {
  id: Uint8Array // 32 bytes
  sender: Uint8Array // 32 bytes
  trimmedAmount: bigint // u64 amount (already trimmed to `trimmedDecimals`)
  trimmedDecimals: number // u8 — typically 6 for ONyc
  sourceToken: Uint8Array // 32 bytes — source-chain token address
  toChain: number // u16 — recipient chain (Solana = 1)
  to: Uint8Array // 32 bytes — recipient on Solana (interpreted as Pubkey)
}

/** Borsh body of `NativeTokenTransfer<EmptyPayload>` — 75 bytes. */
function nativeTokenTransferBorsh(p: NttManagerMessageParams): Uint8Array {
  const buf = new Uint8Array(9 + 32 + 2 + 32)
  const view = new DataView(buf.buffer)
  let o = 0
  // TrimmedAmount (Borsh field order): amount u64 LE, then decimals u8
  view.setBigUint64(o, p.trimmedAmount, true)
  o += 8
  buf[o] = p.trimmedDecimals
  o += 1
  // NativeTokenTransfer (Borsh field order): source_token, to_chain, to
  buf.set(p.sourceToken, o)
  o += 32
  view.setUint16(o, p.toChain, true)
  o += 2
  buf.set(p.to, o)
  o += 32
  // additional_payload = EmptyPayload → 0 bytes (A::SIZE == Some(0))
  return buf
}

/** Borsh body of `NttManagerMessage<NativeTokenTransfer<EmptyPayload>>` — 32 + 32 + 75 = 139 bytes. */
function nttManagerMessageBorsh(p: NttManagerMessageParams): Uint8Array {
  const body = nativeTokenTransferBorsh(p)
  const buf = new Uint8Array(32 + 32 + body.length)
  buf.set(p.id, 0)
  buf.set(p.sender, 32)
  buf.set(body, 64)
  return buf
}

/** Wire body of `NativeTokenTransfer<EmptyPayload>` — 4 + 9 + 32 + 32 + 2 = 79 bytes. */
function nativeTokenTransferWire(p: NttManagerMessageParams): Uint8Array {
  const buf = new Uint8Array(4 + 9 + 32 + 32 + 2)
  const view = new DataView(buf.buffer)
  let o = 0
  // Prefix `0x99 N T T`
  buf.set(NATIVE_TOKEN_TRANSFER_PREFIX, o)
  o += 4
  // TrimmedAmount (wire order, REVERSED): decimals u8, then amount u64 BE
  buf[o] = p.trimmedDecimals
  o += 1
  view.setBigUint64(o, p.trimmedAmount, false)
  o += 8
  // NativeTokenTransfer (wire order): source_token, to, to_chain
  buf.set(p.sourceToken, o)
  o += 32
  buf.set(p.to, o)
  o += 32
  view.setUint16(o, p.toChain, false)
  o += 2
  // No additional_payload bytes when A::SIZE == Some(0)
  return buf
}

/** Wire body of `NttManagerMessage<NativeTokenTransfer<EmptyPayload>>` — 32 + 32 + 2 + 79 = 145 bytes. */
function nttManagerMessageWire(p: NttManagerMessageParams): Uint8Array {
  const inner = nativeTokenTransferWire(p)
  const buf = new Uint8Array(32 + 32 + 2 + inner.length)
  const view = new DataView(buf.buffer)
  let o = 0
  buf.set(p.id, o)
  o += 32
  buf.set(p.sender, o)
  o += 32
  view.setUint16(o, inner.length, false) // payload_len BE
  o += 2
  buf.set(inner, o)
  return buf
}

/**
 * Compute the 32-byte hash that seeds an `InboxItem` PDA:
 *   keccak256(from_chain_id.to_be_bytes() || NttManagerMessage wire bytes)
 *
 * `keccakFn` is a keccak-256 implementation provided by the caller so this
 * file doesn't pick up a hash dependency.
 */
export function computeInboxItemHash(
  fromChain: number,
  message: NttManagerMessageParams,
  keccakFn: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  const wire = nttManagerMessageWire(message)
  const input = new Uint8Array(2 + wire.length)
  new DataView(input.buffer).setUint16(0, fromChain, false) // BE
  input.set(wire, 2)
  return keccakFn(input)
}

/** `ValidatedTransceiverMessage<NativeTokenTransfer<EmptyPayload>>` — 213 bytes. */
export interface ValidatedTransceiverMessageParams {
  fromChain: number
  sourceNttManager: Uint8Array // 32 bytes — peer NTT manager on `fromChain`
  recipientNttManager: Uint8Array // 32 bytes — NTT manager program id on Solana
  message: NttManagerMessageParams
}

export function serializeValidatedTransceiverMessage(p: ValidatedTransceiverMessageParams): Uint8Array {
  const inner = nttManagerMessageBorsh(p.message)
  const buf = new Uint8Array(8 + 2 + 32 + 32 + inner.length)
  const view = new DataView(buf.buffer)
  let o = 0
  buf.set(VALIDATED_TRANSCEIVER_MESSAGE_DISC, o)
  o += 8
  view.setUint16(o, p.fromChain, true) // LE (Borsh)
  o += 2
  buf.set(p.sourceNttManager, o)
  o += 32
  buf.set(p.recipientNttManager, o)
  o += 32
  buf.set(inner, o)
  return buf
}

/**
 * PDA at which the wormhole transceiver creates a `ValidatedTransceiverMessage`
 * after `receive_message`. Seeds: [b"transceiver_message", from_chain_be, message_id].
 *
 * The `ownerProgramId` is the transceiver program ID — the account is owned
 * by that program (for this deployment, the NTT program itself).
 */
export function findValidatedTransceiverMessagePda(
  fromChain: number,
  messageId: Uint8Array,
  ownerProgramId: PublicKey,
): [PublicKey, number] {
  const chainBuf = Buffer.alloc(2)
  chainBuf.writeUInt16BE(fromChain)
  return PublicKey.findProgramAddressSync(
    [TRANSCEIVER_MESSAGE_SEED, chainBuf, Buffer.from(messageId)],
    ownerProgramId,
  )
}

/**
 * Inject a `ValidatedTransceiverMessage` at the given address. The NTT redeem
 * CPI requires this account's owner to equal `RegisteredTransceiver.transceiver_address`.
 * For OnRe's deployment, the transceiver is compiled into the NTT manager
 * program itself, so `ownerProgramId` is the per-leg NTT manager program id.
 */
export function setValidatedTransceiverMessage(
  svm: LiteSVM,
  address: PublicKey,
  ownerProgramId: PublicKey,
  params: ValidatedTransceiverMessageParams,
): void {
  svm.setAccount(address, {
    executable: false,
    owner: ownerProgramId,
    lamports: 3_264_240,
    data: serializeValidatedTransceiverMessage(params),
    rentEpoch: 0,
  })
}

/** Inject a `RegisteredTransceiver` account at the PDA for `transceiver`. */
export function setRegisteredTransceiver(
  svm: LiteSVM,
  transceiver: PublicKey,
  id: number,
  programId: PublicKey,
): PublicKey {
  const [pda, bump] = findRegisteredTransceiverPda(transceiver, programId)
  svm.setAccount(pda, {
    executable: false,
    owner: programId,
    lamports: 1_176_240,
    data: serializeRegisteredTransceiver({
      bump,
      id,
      transceiverAddress: transceiver,
    }),
    rentEpoch: 0,
  })
  return pda
}

// ---------------------------------------------------------------------------
// Mainnet-fixture loader + patcher
// ---------------------------------------------------------------------------

/**
 * Load a mainnet NTT account fixture and relocate it to the PDA derived
 * under `programId`, patching the bump byte (where applicable) so Anchor's
 * `seeds` constraint succeeds against the new derivation.
 *
 * Mainnet fixtures were captured under the USDC manager (`nttu74…`); when a
 * test routes CPIs through the ONyc manager (`nttpna…`), every NTT PDA
 * derives to a different address. This helper bridges that gap without
 * requiring a separate mainnet capture per program ID.
 */
function relocateNttFixture(
  svm: LiteSVM,
  fixtureAddr: string,
  destPda: PublicKey,
  destBump: number | null,
  programId: PublicKey,
  patch?: (data: Uint8Array) => void,
): void {
  loadFixture(svm, fixtureAddr)
  const src = svm.getAccount(new PublicKey(fixtureAddr))
  if (!src) {
    throw new Error(`relocateNttFixture: ${fixtureAddr} not loaded into LiteSVM`)
  }
  const data = new Uint8Array(src.data)
  if (destBump !== null) {
    data[8] = destBump // bump is the first field after the 8-byte Anchor disc
  }
  patch?.(data)
  svm.setAccount(destPda, {
    executable: false,
    owner: programId,
    lamports: src.lamports,
    data,
    rentEpoch: 0,
  })
}

/**
 * Load + patch the NTT Config PDA for `programId`, binding it to `mint` /
 * `custodyAta` in Locking mode.
 *
 * The on-chain layout has TWO custody slots (likely a historical artifact);
 * both are patched to the same ATA so all NTT code paths see the same
 * custody account.
 */
export function loadAndPatchNttConfig(
  svm: LiteSVM,
  mint: PublicKey,
  custodyAta: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [destPda, destBump] = findNttConfigPda(programId)
  relocateNttFixture(svm, NTT_CONFIG_FIXTURE, destPda, destBump, programId, (data) => {
    data.set(mint.toBytes(), CONFIG_MINT_OFFSET)
    data[CONFIG_MODE_OFFSET] = NttMode.Locking
    data.set(custodyAta.toBytes(), CONFIG_CUSTODY_OFFSET_1)
    data.set(custodyAta.toBytes(), CONFIG_CUSTODY_OFFSET_2)
  })
  return destPda
}

/** Load the NTT Peer fixture at the PDA derived under `programId` for FOGO. */
export function loadAndPatchNttPeer(
  svm: LiteSVM,
  programId: PublicKey,
  chainId: number = 51,
): PublicKey {
  const [destPda, destBump] = findNttPeerPda(chainId, programId)
  relocateNttFixture(svm, NTT_PEER_FIXTURE, destPda, destBump, programId)
  return destPda
}

/**
 * Load the NTT InboxRateLimit fixture at the PDA derived under `programId`
 * for FOGO, with `last_tx_timestamp` zeroed so the `ts <= now` check in NTT
 * passes regardless of LiteSVM's wall clock.
 */
export function loadAndPatchNttInboxRateLimit(
  svm: LiteSVM,
  programId: PublicKey,
  chainId: number = 51,
): PublicKey {
  const [destPda, destBump] = findInboxRateLimitPda(chainId, programId)
  relocateNttFixture(svm, NTT_INBOX_RL_FIXTURE, destPda, destBump, programId, (data) => {
    // InboxRateLimit: disc(8) + bump(1) + limit(8) + capacity(8) + last_tx_timestamp(i64@25)
    new DataView(data.buffer, data.byteOffset).setBigInt64(25, 0n, true)
  })
  return destPda
}

/**
 * Load the NTT OutboxRateLimit fixture at the PDA derived under `programId`,
 * with `last_tx_timestamp` zeroed. OutboxRateLimit has no stored bump field
 * (Anchor uses canonical-bump semantics), so no bump patch is needed.
 */
export function loadAndPatchNttOutboxRateLimit(
  svm: LiteSVM,
  programId: PublicKey,
): PublicKey {
  const [destPda] = findOutboxRateLimitPda(programId)
  relocateNttFixture(svm, NTT_OUTBOX_RL_FIXTURE, destPda, null, programId, (data) => {
    // OutboxRateLimit: disc(8) + limit(8) + capacity(8) + last_tx_timestamp(i64@24)
    new DataView(data.buffer, data.byteOffset).setBigInt64(24, 0n, true)
  })
  return destPda
}

/**
 * Read the peer's 32-byte `address` field from a loaded NTT Peer PDA, so
 * inbound message synthesis can use the real source-NTT-manager pubkey
 * instead of a placeholder.
 */
export function readPeerAddress(svm: LiteSVM, peerPda: PublicKey): Uint8Array {
  const acct = svm.getAccount(peerPda)
  if (!acct) {
    throw new Error(
      `readPeerAddress: peer PDA ${peerPda.toBase58()} not loaded `
      + '(call loadAndPatchNttPeer first)',
    )
  }
  return new Uint8Array(acct.data).slice(PEER_ADDRESS_OFFSET, PEER_ADDRESS_OFFSET + 32)
}
