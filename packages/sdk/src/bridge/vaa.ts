import { Buffer } from 'node:buffer'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { PublicKey } from '@solana/web3.js'
import { findInboxItemPda } from '../builders/ntt'

/**
 * VAA + Wormhole-NTT-transceiver + NttManagerMessage wire decoders plus the
 * PDA derivations `receive` needs:
 *   - `nttInboxItem`          = ["inbox_item", keccak256(from_chain_BE || ntt_manager_message_wire)]
 *   - `nttTransceiverMessage` = ["transceiver_message", from_chain_BE, message_id]
 *
 * Read-only mirror of `tests/utils/ntt-accounts.ts` (see there for wire-vs-Borsh
 * notes). NOT a VAA validator — the Solana NTT manager re-verifies guardian
 * signatures during redeem; we only parse enough to address accounts + report status.
 */

const TRANSCEIVER_MESSAGE_SEED = Buffer.from('transceiver_message')

// Wormhole NTT transceiver wire prefix. Verified against
// upstream `solana/programs/wormhole-transceiver/src/messages.rs`.
const WH_TRANSCEIVER_PREFIX = Uint8Array.from([0x99, 0x45, 0xFF, 0x10])
// Inner NativeTokenTransfer wire prefix (see tests/utils/ntt-accounts.ts:71).
const NATIVE_TOKEN_TRANSFER_PREFIX = Uint8Array.from([0x99, 0x4E, 0x54, 0x54])

export interface ParsedVaa {
  version: number
  guardianSetIndex: number
  signatures: Uint8Array[]
  timestamp: number
  nonce: number
  emitterChain: number
  emitterAddress: Uint8Array
  sequence: bigint
  consistencyLevel: number
  payload: Uint8Array
}

export function parseVaa(bytes: Uint8Array): ParsedVaa {
  if (bytes.length < 6) {
    throw new Error(`VAA too short: ${bytes.length} bytes`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let o = 0
  const version = bytes[o]
  o += 1
  const guardianSetIndex = view.getUint32(o, false)
  o += 4
  const sigCount = bytes[o]
  o += 1
  // Each signature is 1-byte guardian index + 65-byte ECDSA sig.
  const signatures: Uint8Array[] = []
  for (let i = 0; i < sigCount; i++) {
    if (o + 66 > bytes.length) {
      throw new Error(`VAA truncated in signatures[${i}]`)
    }
    signatures.push(bytes.slice(o, o + 66))
    o += 66
  }
  if (o + 4 + 4 + 2 + 32 + 8 + 1 > bytes.length) {
    throw new Error('VAA truncated in body header')
  }
  const timestamp = view.getUint32(o, false)
  o += 4
  const nonce = view.getUint32(o, false)
  o += 4
  const emitterChain = view.getUint16(o, false)
  o += 2
  const emitterAddress = bytes.slice(o, o + 32)
  o += 32
  const sequence = view.getBigUint64(o, false)
  o += 8
  const consistencyLevel = bytes[o]
  o += 1
  const payload = bytes.slice(o)
  return {
    version,
    guardianSetIndex,
    signatures,
    timestamp,
    nonce,
    emitterChain,
    emitterAddress,
    sequence,
    consistencyLevel,
    payload,
  }
}

/**
 * Wormhole-transceiver wrapper around an NttManagerMessage. The relayer
 * reads `sourceNttManager` / `recipientNttManager` and the inner manager
 * message bytes; the trailing `transceiverPayload` is empty in the
 * default deployment.
 */
export interface ParsedTransceiverMessage {
  sourceNttManager: Uint8Array
  recipientNttManager: Uint8Array
  /** Wire bytes of NttManagerMessage — what we keccak256 to seed inbox_item. */
  nttManagerPayload: Uint8Array
  transceiverPayload: Uint8Array
}

export function parseTransceiverMessage(payload: Uint8Array): ParsedTransceiverMessage {
  if (payload.length < 4 + 32 + 32 + 2) {
    throw new Error(`transceiver payload too short: ${payload.length} bytes`)
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  if (!equalBytes(payload.slice(0, 4), WH_TRANSCEIVER_PREFIX)) {
    throw new Error(
      `transceiver prefix mismatch: got 0x${Buffer.from(payload.slice(0, 4)).toString('hex')}, `
      + `expected 0x${Buffer.from(WH_TRANSCEIVER_PREFIX).toString('hex')}`,
    )
  }
  let o = 4
  const sourceNttManager = payload.slice(o, o + 32)
  o += 32
  const recipientNttManager = payload.slice(o, o + 32)
  o += 32
  const mgrLen = view.getUint16(o, false)
  o += 2
  if (o + mgrLen + 2 > payload.length) {
    throw new Error(`transceiver payload truncated in ntt_manager_payload (declared ${mgrLen} bytes)`)
  }
  const nttManagerPayload = payload.slice(o, o + mgrLen)
  o += mgrLen
  const xcvrLen = view.getUint16(o, false)
  o += 2
  if (o + xcvrLen > payload.length) {
    throw new Error(`transceiver payload truncated in transceiver_payload (declared ${xcvrLen} bytes)`)
  }
  const transceiverPayload = payload.slice(o, o + xcvrLen)
  return { sourceNttManager, recipientNttManager, nttManagerPayload, transceiverPayload }
}

/**
 * Decoded NttManagerMessage<NativeTokenTransfer<EmptyPayload>> — wire form.
 *
 * `id` is what seeds the transceiver_message PDA; `sender` is the
 * originating wallet on the source chain (= our `userWallet` for the
 * deposit leg, same key on FOGO and Solana).
 */
export interface ParsedNttManagerMessage {
  id: Uint8Array
  sender: Uint8Array
  trimmedAmount: bigint
  trimmedDecimals: number
  sourceToken: Uint8Array
  to: Uint8Array
  toChain: number
}

export function parseNttManagerMessage(wire: Uint8Array): ParsedNttManagerMessage {
  if (wire.length < 32 + 32 + 2) {
    throw new Error(`ntt manager message too short: ${wire.length} bytes`)
  }
  const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength)
  let o = 0
  const id = wire.slice(o, o + 32)
  o += 32
  const sender = wire.slice(o, o + 32)
  o += 32
  const innerLen = view.getUint16(o, false)
  o += 2
  if (o + innerLen > wire.length) {
    throw new Error(`ntt manager message truncated in inner payload (declared ${innerLen})`)
  }
  const inner = wire.slice(o, o + innerLen)
  // Inner = NativeTokenTransfer wire = prefix(4) + decimals(1) + amount(u64 BE)
  //                                  + sourceToken(32) + to(32) + toChain(u16 BE)
  if (inner.length < 4 + 1 + 8 + 32 + 32 + 2) {
    throw new Error(`native_token_transfer too short: ${inner.length} bytes`)
  }
  if (!equalBytes(inner.slice(0, 4), NATIVE_TOKEN_TRANSFER_PREFIX)) {
    throw new Error(`native_token_transfer prefix mismatch`)
  }
  const innerView = new DataView(inner.buffer, inner.byteOffset, inner.byteLength)
  let p = 4
  const trimmedDecimals = inner[p]
  p += 1
  const trimmedAmount = innerView.getBigUint64(p, false)
  p += 8
  const sourceToken = inner.slice(p, p + 32)
  p += 32
  const to = inner.slice(p, p + 32)
  p += 32
  const toChain = innerView.getUint16(p, false)
  return { id, sender, trimmedAmount, trimmedDecimals, sourceToken, to, toChain }
}

/**
 * Compute the keccak256 hash that seeds the `inbox_item` PDA. Mirrors
 * `tests/utils/ntt-accounts.ts::computeInboxItemHash` exactly:
 *   keccak256(from_chain_BE || ntt_manager_message_wire)
 */
export function inboxItemMessageHash(fromChain: number, nttManagerWire: Uint8Array): Uint8Array {
  const buf = new Uint8Array(2 + nttManagerWire.length)
  new DataView(buf.buffer).setUint16(0, fromChain, false)
  buf.set(nttManagerWire, 2)
  return keccak_256(buf)
}

export function findValidatedTransceiverMessagePda(
  fromChain: number,
  messageId: Uint8Array,
  transceiverProgramId: PublicKey,
): PublicKey {
  const chainBuf = Buffer.alloc(2)
  chainBuf.writeUInt16BE(fromChain)
  const [pda] = PublicKey.findProgramAddressSync(
    [TRANSCEIVER_MESSAGE_SEED, chainBuf, Buffer.from(messageId)],
    transceiverProgramId,
  )
  return pda
}

/**
 * One-shot: signed VAA bytes → everything needed to call `receive`.
 * Throws with a precise message at the first parse failure
 * (so the caller can distinguish a malformed VAA from a non-NTT emitter).
 */
export interface ResolvedNttVaa {
  vaa: ParsedVaa
  transceiver: ParsedTransceiverMessage
  manager: ParsedNttManagerMessage
  /** From-chain (= VAA emitter chain). NTT redeem PDAs key on this. */
  fromChain: number
  /** Address of the on-chain `inbox_item` PDA under the NTT manager. */
  nttInboxItem: PublicKey
  /** Address of the on-chain `transceiver_message` PDA under the transceiver. */
  nttTransceiverMessage: PublicKey
  /** 32-byte recipient on Solana (interpreted as a Pubkey). */
  recipientOnSolana: PublicKey
  /** 32-byte sender on the source chain (= user wallet for relayer flows). */
  senderOnSource: PublicKey
}

export function resolveNttVaa(params: {
  vaaBytes: Uint8Array
  /** NTT manager program id this VAA is destined for (USDC.s or ONyc). */
  nttProgramId: PublicKey
  /**
   * Transceiver program id that owns the `transceiver_message` PDA. For
   * OnRe's deployment the transceiver is compiled into the NTT manager
   * binary, so this typically equals `nttProgramId`.
   */
  transceiverProgramId?: PublicKey
}): ResolvedNttVaa {
  const vaa = parseVaa(params.vaaBytes)
  const transceiver = parseTransceiverMessage(vaa.payload)
  const manager = parseNttManagerMessage(transceiver.nttManagerPayload)
  const transceiverProgramId = params.transceiverProgramId ?? params.nttProgramId
  const messageHash = inboxItemMessageHash(vaa.emitterChain, transceiver.nttManagerPayload)
  const [nttInboxItem] = findInboxItemPda(messageHash, params.nttProgramId)
  return {
    vaa,
    transceiver,
    manager,
    fromChain: vaa.emitterChain,
    nttInboxItem,
    nttTransceiverMessage: findValidatedTransceiverMessagePda(
      vaa.emitterChain,
      manager.id,
      transceiverProgramId,
    ),
    recipientOnSolana: new PublicKey(manager.to),
    senderOnSource: new PublicKey(manager.sender),
  }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
}
