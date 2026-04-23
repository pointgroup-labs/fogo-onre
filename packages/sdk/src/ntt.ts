import { keccak_256 } from '@noble/hashes/sha3.js'
import { PublicKey } from '@solana/web3.js'
import { NTT_PROGRAM_ID } from './constants'

// ---------------------------------------------------------------------------
// PDA seed constants (mirror Wormhole NTT manager source)
// ---------------------------------------------------------------------------

const CONFIG_SEED = Buffer.from('config')
const NTT_MANAGER_PEER_SEED = Buffer.from('peer')
const REGISTERED_TRANSCEIVER_SEED = Buffer.from('registered_transceiver')
const INBOX_RATE_LIMIT_SEED = Buffer.from('inbox_rate_limit')
const OUTBOX_RATE_LIMIT_SEED = Buffer.from('outbox_rate_limit')
const INBOX_ITEM_SEED = Buffer.from('inbox_item')
const TOKEN_AUTHORITY_SEED = Buffer.from('token_authority')
const SESSION_AUTHORITY_SEED = Buffer.from('session_authority')

function chainIdBeBuf(chainId: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(chainId)
  return buf
}

// ---------------------------------------------------------------------------
// PDA derivations — Wormhole NTT manager (Solana, Locking mode for ONyc)
// ---------------------------------------------------------------------------

export function findNttConfigPda(programId: PublicKey = NTT_PROGRAM_ID): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)
}

export function findNttPeerPda(
  chainId: number,
  programId: PublicKey = NTT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NTT_MANAGER_PEER_SEED, chainIdBeBuf(chainId)],
    programId,
  )
}

export function findRegisteredTransceiverPda(
  transceiver: PublicKey,
  programId: PublicKey = NTT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REGISTERED_TRANSCEIVER_SEED, transceiver.toBuffer()],
    programId,
  )
}

export function findInboxRateLimitPda(
  chainId: number,
  programId: PublicKey = NTT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [INBOX_RATE_LIMIT_SEED, chainIdBeBuf(chainId)],
    programId,
  )
}

export function findOutboxRateLimitPda(
  programId: PublicKey = NTT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([OUTBOX_RATE_LIMIT_SEED], programId)
}

export function findTokenAuthorityPda(
  programId: PublicKey = NTT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TOKEN_AUTHORITY_SEED], programId)
}

export function findInboxItemPda(
  messageHash: Uint8Array,
  programId: PublicKey = NTT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [INBOX_ITEM_SEED, Buffer.from(messageHash)],
    programId,
  )
}

/**
 * NTT binds the per-call `session_authority` PDA to a hash of the
 * outbound transfer args. The relayer pre-approves this PDA as SPL
 * delegate before invoking `transfer_lock`, so the SDK must compute the
 * exact same PDA the on-chain handler computes.
 */
export function findSessionAuthorityPda(
  fromOwner: PublicKey,
  argsHash: Uint8Array,
  programId: PublicKey = NTT_PROGRAM_ID,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [SESSION_AUTHORITY_SEED, fromOwner.toBuffer(), Buffer.from(argsHash)],
    programId,
  )
}

/**
 * Compute the 32-byte hash of NTT `TransferArgs`, matching the on-chain
 * `TransferArgs::keccak256()` implementation:
 *   keccak256(amount BE u64 ‖ recipient_chain BE u16 ‖ recipient_address[32] ‖ should_queue u8)
 */
export function nttTransferArgsHash(args: {
  amount: bigint
  recipientChain: number
  recipientAddress: Uint8Array
  shouldQueue: boolean
}): Uint8Array {
  const buf = new Uint8Array(8 + 2 + 32 + 1)
  const view = new DataView(buf.buffer)
  view.setBigUint64(0, args.amount, false) // BE
  view.setUint16(8, args.recipientChain, false) // BE
  buf.set(args.recipientAddress, 10)
  buf[42] = args.shouldQueue ? 1 : 0
  return keccak_256(buf)
}

// ---------------------------------------------------------------------------
// Context types — caller-supplied "anchor points" the SDK can't derive itself
// ---------------------------------------------------------------------------

/**
 * Inputs needed to build the NTT redeem + release_inbound_unlock account
 * lists for `unlock_onyc`. Everything here is derivable from on-chain NTT
 * state EXCEPT the per-VAA accounts (`nttInboxItem`, `nttTransceiverMessage`)
 * which are addressable only off-chain via the relayer's VAA pipeline.
 *
 * NOTE: source chain is fixed to FOGO (51). The relayer-program does not
 * support any other source, and exposing a chain override would let the
 * SDK build PDAs (peer, inbox_rate_limit) that the on-chain code can never
 * match, silently breaking the CPI.
 */
export interface NttRedeemContext {
  /** Address of the registered transceiver program (for OnRe = NTT itself). */
  transceiverAddress: PublicKey
  /** ONyc custody token account (from NTT config). */
  custody: PublicKey
}

/**
 * Inputs needed to build the NTT transfer_lock account list for `lock_onyc`.
 * The SDK fetches the Flow PDA to learn `amount` + `fogo_sender`, so callers
 * only need to supply the on-chain anchor points.
 *
 * NOTE: recipient chain is fixed to FOGO (51). The relayer-program hardcodes
 * `recipient_chain: FOGO_WORMHOLE_CHAIN_ID` in its NTT `TransferArgs`; any
 * SDK-side override would derive a different `session_authority` PDA from
 * the args hash, causing the relayer's pre-CPI SPL `Approve` to delegate
 * tokens to the wrong PDA — silent CPI failure.
 */
export interface NttTransferLockContext {
  /** ONyc custody token account (from NTT config). */
  custody: PublicKey
}
