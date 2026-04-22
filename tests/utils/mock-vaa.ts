/**
 * Helpers for building Wormhole PostedVAA account data for LiteSVM tests.
 *
 * Layout matches the Wormhole Core Bridge Solitaire "PostedVAA" struct:
 *   [0..3]   tag ("msg" or "msu")
 *   [3]      vaa_version
 *   [4]      consistency_level
 *   [5..9]   vaa_time (u32 LE)
 *   [9..41]  vaa_signature_account (Pubkey)
 *   [41..45] submission_time (u32 LE)
 *   [45..49] nonce (u32 LE)
 *   [49..57] sequence (u64 LE)
 *   [57..59] emitter_chain (u16 LE)
 *   [59..91] emitter_address (32 bytes)
 *   [91..95] payload_len (u32 LE, Borsh Vec prefix)
 *   [95..]   payload bytes
 *
 * For Token Bridge TransferWithPayload (payload_id=3):
 *   [0]       payload_id = 3
 *   [1..33]   amount (u256 BE)
 *   [33..65]  token_address (32 bytes)
 *   [65..67]  token_chain (u16 BE)
 *   [67..99]  to (32 bytes, recipient on target chain)
 *   [99..101] to_chain (u16 BE)
 *   [101..133] from_address (32 bytes, sender on source chain)
 *   [133..]   additional_payload (last 32 bytes = fogo_sender)
 */

import { PublicKey } from '@solana/web3.js'

const WORMHOLE_CORE_BRIDGE_ID = new PublicKey('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth')

export interface PostedVaaParams {
  /** FOGO user wallet (32 bytes) — placed as last 32 bytes of additional_payload */
  fogoSender: Uint8Array
  /** Amount in the transfer (u64, will be placed in u256 BE field) */
  amount: bigint
  /** Token address on source chain */
  tokenAddress?: Uint8Array
  /** Token chain ID (BE) */
  tokenChain?: number
  /** Recipient on target chain (relayer authority PDA) */
  to?: Uint8Array
  /** Target chain */
  toChain?: number
  /** Sender on source chain (from_address) */
  fromAddress?: Uint8Array
  /** Emitter chain ID */
  emitterChain?: number
  /** Emitter address (32 bytes) */
  emitterAddress?: Uint8Array
  /** Sequence number */
  sequence?: bigint
  /** Nonce */
  nonce?: number
}

/**
 * Build a PostedVAA account data buffer for a Token Bridge TransferWithPayload.
 */
export function buildPostedVaaData(params: PostedVaaParams): Uint8Array {
  const fogoSender = params.fogoSender
  if (fogoSender.length !== 32) { throw new Error('fogoSender must be 32 bytes') }

  // Build Token Bridge payload
  // payload_id(1) + amount(32) + token_address(32) + token_chain(2) +
  // to(32) + to_chain(2) + from_address(32) + additional_payload(fogoSender=32)
  const payloadSize = 1 + 32 + 32 + 2 + 32 + 2 + 32 + 32
  const payload = new Uint8Array(payloadSize)
  const pv = new DataView(payload.buffer)

  let offset = 0
  // payload_id = 3
  payload[offset++] = 3

  // amount (u256 BE) — put the u64 in the last 8 bytes of the 32-byte field
  const amountBytes = new Uint8Array(32)
  const amountView = new DataView(amountBytes.buffer)
  amountView.setBigUint64(24, params.amount, false) // BE
  payload.set(amountBytes, offset)
  offset += 32

  // token_address
  payload.set(params.tokenAddress ?? new Uint8Array(32), offset)
  offset += 32

  // token_chain (u16 BE)
  pv.setUint16(offset, params.tokenChain ?? 1, false)
  offset += 2

  // to (recipient)
  payload.set(params.to ?? new Uint8Array(32), offset)
  offset += 32

  // to_chain (u16 BE)
  pv.setUint16(offset, params.toChain ?? 1, false)
  offset += 2

  // from_address
  payload.set(params.fromAddress ?? new Uint8Array(32), offset)
  offset += 32

  // additional_payload = fogoSender
  payload.set(fogoSender, offset)

  // Build full PostedVAA account data
  const headerSize = 95
  const totalSize = headerSize + payload.length
  const data = new Uint8Array(totalSize)
  const dv = new DataView(data.buffer)

  // tag = "msg"
  data[0] = 0x6D // 'm'
  data[1] = 0x73 // 's'
  data[2] = 0x67 // 'g'

  // vaa_version = 1
  data[3] = 1

  // consistency_level
  data[4] = 32

  // vaa_time (u32 LE)
  dv.setUint32(5, Math.floor(Date.now() / 1000), true)

  // vaa_signature_account (32 bytes) — dummy
  // offset 9..41 — leave zeros

  // submission_time (u32 LE)
  dv.setUint32(41, Math.floor(Date.now() / 1000), true)

  // nonce (u32 LE)
  dv.setUint32(45, params.nonce ?? 0, true)

  // sequence (u64 LE)
  dv.setBigUint64(49, params.sequence ?? 0n, true)

  // emitter_chain (u16 LE)
  dv.setUint16(57, params.emitterChain ?? 51, true)

  // emitter_address (32 bytes)
  if (params.emitterAddress) {
    data.set(params.emitterAddress, 59)
  }

  // payload_len (Borsh u32 LE)
  dv.setUint32(91, payload.length, true)

  // payload
  data.set(payload, headerSize)

  return data
}

/**
 * Inject a PostedVAA account into LiteSVM, owned by the Wormhole Core Bridge.
 */
export function setPostedVaa(
  svm: any,
  address: PublicKey,
  params: PostedVaaParams,
): void {
  const data = buildPostedVaaData(params)
  svm.setAccount(address, {
    executable: false,
    owner: WORMHOLE_CORE_BRIDGE_ID,
    lamports: 1_000_000,
    data,
    rentEpoch: 0,
  })
}
