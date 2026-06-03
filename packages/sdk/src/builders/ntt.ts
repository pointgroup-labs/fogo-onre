import type { AccountMeta } from '@solana/web3.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js'
import { FOGO_WORMHOLE_CHAIN_ID } from '../constants'
import { readonly, signerWritable, writable } from '../utils/accountMeta'

const CONFIG_SEED = Buffer.from('config')
const NTT_MANAGER_PEER_SEED = Buffer.from('peer')
const REGISTERED_TRANSCEIVER_SEED = Buffer.from('registered_transceiver')
const INBOX_RATE_LIMIT_SEED = Buffer.from('inbox_rate_limit')
const OUTBOX_RATE_LIMIT_SEED = Buffer.from('outbox_rate_limit')
const INBOX_ITEM_SEED = Buffer.from('inbox_item')
const TOKEN_AUTHORITY_SEED = Buffer.from('token_authority')
const SESSION_AUTHORITY_SEED = Buffer.from('session_authority')
const EMITTER_SEED = Buffer.from('emitter')
const WORMHOLE_MESSAGE_SEED = Buffer.from('message')

function chainIdBeBuf(chainId: number): Buffer {
  const buf = Buffer.alloc(2)
  buf.writeUInt16BE(chainId)
  return buf
}

export function findNttConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)
}

export function findNttPeerPda(
  chainId: number,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [NTT_MANAGER_PEER_SEED, chainIdBeBuf(chainId)],
    programId,
  )
}

export function findRegisteredTransceiverPda(
  transceiver: PublicKey,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [REGISTERED_TRANSCEIVER_SEED, transceiver.toBuffer()],
    programId,
  )
}

export function findInboxRateLimitPda(
  chainId: number,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [INBOX_RATE_LIMIT_SEED, chainIdBeBuf(chainId)],
    programId,
  )
}

export function findOutboxRateLimitPda(
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([OUTBOX_RATE_LIMIT_SEED], programId)
}

export function findTokenAuthorityPda(
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([TOKEN_AUTHORITY_SEED], programId)
}

export function findInboxItemPda(
  messageHash: Uint8Array,
  programId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [INBOX_ITEM_SEED, Buffer.from(messageHash)],
    programId,
  )
}

/** `Config.custody` = `token_authority` PDA's ATA for `mint`; pinned at `initialize`, so derivable without an RPC fetch. */
export function findNttCustodyAta(
  mint: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [tokenAuthorityPda] = findTokenAuthorityPda(programId)
  return getAssociatedTokenAddressSync(mint, tokenAuthorityPda, true)
}

/**
 * Per-call `session_authority` PDA, bound to a hash of the transfer args.
 * The relayer pre-approves it as SPL delegate before `transfer_lock`, so
 * this must match the on-chain derivation exactly.
 */
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

export interface NttTransferArgs {
  amount: bigint
  recipientChain: number
  recipientAddress: Uint8Array
  shouldQueue: boolean
}

/**
 * 43-byte `TransferArgs` layout: amount u64 ‖ chain u16 ‖ recipient[32] ‖
 * should_queue u8. On-chain `keccak256()` reads big-endian; Borsh ix data
 * reads little-endian — same fields otherwise.
 */
function serializeTransferArgs(args: NttTransferArgs, littleEndian: boolean): Uint8Array {
  if (args.recipientAddress.length !== 32) {
    throw new Error('NttTransferArgs: recipientAddress must be 32 bytes')
  }
  const buf = new Uint8Array(8 + 2 + 32 + 1)
  const view = new DataView(buf.buffer)
  view.setBigUint64(0, args.amount, littleEndian)
  view.setUint16(8, args.recipientChain, littleEndian)
  buf.set(args.recipientAddress, 10)
  buf[42] = args.shouldQueue ? 1 : 0
  return buf
}

export function nttTransferArgsHash(args: NttTransferArgs): Uint8Array {
  return keccak_256(serializeTransferArgs(args, false))
}

/** Borsh-encode `TransferArgs` (little-endian) for the NTT ix `data` payload. */
export function encodeNttTransferArgsBorsh(args: NttTransferArgs): Uint8Array {
  return serializeTransferArgs(args, true)
}

/** Per-VAA redeem inputs for `receive` (not derivable from on-chain NTT state). */
export interface NttRedeemContext {
  /** Registered transceiver program (for OnRe = the NTT manager itself). */
  transceiverAddress: PublicKey
}

/**
 * Params for the 14-entry NTT v1 `transfer_lock` account list. Used by
 * both relayer-side `send` (PDA source) and FOGO-side user flows (wallet
 * source). Order matches the NTT `TransferLock` struct — reordering
 * silently breaks the CPI.
 */
export interface BuildNttTransferLockAccountListParams {
  /** NTT manager program id — Solana for relayer-side, FOGO-side for user-signed. */
  nttProgramId: PublicKey
  /** Source token-account owner. PDA on the relayer side, user wallet on the user side. */
  fromOwner: PublicKey
  /** True iff `fromOwner` is a tx-level signer (user-side); false when signed via PDA seeds. */
  fromOwnerIsSigner: boolean
  /** SPL token account holding the tokens to transfer. */
  fromTokenAccount: PublicKey
  /** Mint of `fromTokenAccount`. */
  mint: PublicKey
  /** Fresh keypair pubkey — must sign and is `init`'d as the per-call outbox item. */
  outboxItem: PublicKey
  /** Wormhole chain id of the destination chain. */
  recipientChain: number
  /** 32-byte address on the destination chain (left-padded as needed). */
  recipientAddress: Uint8Array
  /** Transfer amount in token base units. */
  amount: bigint
  /** Optional NTT outbound queue toggle; defaults false (immediate send). */
  shouldQueue?: boolean
}

/** Trailing-account count NTT `transfer_lock` unpacks; relayer `send` uses it as the split marker. */
export const NTT_TRANSFER_LOCK_ACCOUNT_COUNT = 14

export function buildNttTransferLockAccountList(
  params: BuildNttTransferLockAccountListParams,
): AccountMeta[] {
  const shouldQueue = params.shouldQueue ?? false
  const [configPda] = findNttConfigPda(params.nttProgramId)
  const [peerPda] = findNttPeerPda(params.recipientChain, params.nttProgramId)
  const [outboxRateLimitPda] = findOutboxRateLimitPda(params.nttProgramId)
  const [inboxRateLimitPda] = findInboxRateLimitPda(params.recipientChain, params.nttProgramId)
  const [tokenAuthorityPda] = findTokenAuthorityPda(params.nttProgramId)
  const custody = findNttCustodyAta(params.mint, params.nttProgramId)

  const argsHash = nttTransferArgsHash({
    amount: params.amount,
    recipientChain: params.recipientChain,
    recipientAddress: params.recipientAddress,
    shouldQueue,
  })
  const [sessionAuthorityPda] = findSessionAuthorityPda(
    params.fromOwner,
    argsHash,
    params.nttProgramId,
  )

  const accounts: AccountMeta[] = [
    // entry 0 has parameterised `isSigner` (PDA on relayer side, user on FOGO side) — keep literal.
    { pubkey: params.fromOwner, isSigner: params.fromOwnerIsSigner, isWritable: true },
    readonly(configPda),
    writable(params.mint),
    writable(params.fromTokenAccount),
    readonly(TOKEN_PROGRAM_ID),
    { pubkey: params.outboxItem, isSigner: true, isWritable: true },
    writable(outboxRateLimitPda),
    writable(custody),
    readonly(SystemProgram.programId),
    writable(inboxRateLimitPda),
    readonly(peerPda),
    readonly(sessionAuthorityPda),
    readonly(tokenAuthorityPda),
    readonly(params.nttProgramId),
  ]
  if (accounts.length !== NTT_TRANSFER_LOCK_ACCOUNT_COUNT) {
    throw new Error(
      `NTT transfer_lock account list drift: expected ${NTT_TRANSFER_LOCK_ACCOUNT_COUNT}, got ${accounts.length}`,
    )
  }
  return accounts
}

/** NTT transceiver-emitter PDA `["emitter"]`. OnRe's manager *is* the transceiver. */
export function findNttEmitterPda(
  transceiverProgramId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([EMITTER_SEED], transceiverProgramId)
}

/** Per-outbox Wormhole message PDA `["message", outbox_item]`. Writable — NTT v3 inits it in `release_wormhole_outbound`. */
export function findNttWormholeMessagePda(
  outboxItem: PublicKey,
  transceiverProgramId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [WORMHOLE_MESSAGE_SEED, outboxItem.toBuffer()],
    transceiverProgramId,
  )
}

/**
 * Inputs for NTT v3 `release_wormhole_outbound` — the publish CPI that
 * follows `transfer_lock`. Wormhole Core PDAs are caller-supplied (their
 * derivation depends on the cluster's Wormhole Core program ID).
 */
export interface BuildNttReleaseWormholeOutboundAccountListParams {
  /** Permissionless cranker (signs + pays). */
  payer: PublicKey
  /** NTT manager program id (USDC.s or ONyc on Solana). */
  nttProgramId: PublicKey
  /** Manager-as-transceiver program id. Defaults to `nttProgramId` on this stack. */
  transceiverProgramId?: PublicKey
  /** Outbox item PDA created by the preceding `transfer_lock`. */
  outboxItem: PublicKey
  /** Per-outbox Wormhole message PDA — derivable; pass to override. */
  wormholeMessage?: PublicKey
  /** Transceiver-emitter PDA — derivable; pass to override. */
  emitter?: PublicKey
  /** Wormhole Core program id (cluster-specific). */
  wormholeProgram: PublicKey
  /** Wormhole Core `Bridge` config account. */
  wormholeBridge: PublicKey
  /** Wormhole Core fee-collector account. */
  wormholeFeeCollector: PublicKey
  /** Wormhole Core per-emitter sequence tracker. */
  wormholeSequence: PublicKey
  /** NTT v3 outbox-item signer PDA — caller derives via Wormhole NTT SDK. */
  outboxItemSigner: PublicKey
}

/**
 * 15-entry account list for NTT v3 `release_wormhole_outbound`. Order
 * verified against mainnet tx `3NR6EEbk…` — reordering breaks the CPI.
 */
export function buildNttReleaseWormholeOutboundAccountList(
  params: BuildNttReleaseWormholeOutboundAccountListParams,
): AccountMeta[] {
  const transceiverProgramId = params.transceiverProgramId ?? params.nttProgramId
  const [configPda] = findNttConfigPda(params.nttProgramId)
  const [registeredTransceiverPda] = findRegisteredTransceiverPda(
    transceiverProgramId,
    params.nttProgramId,
  )
  const wormholeMessage
    = params.wormholeMessage
      ?? findNttWormholeMessagePda(params.outboxItem, transceiverProgramId)[0]
  const emitter = params.emitter ?? findNttEmitterPda(transceiverProgramId)[0]

  return [
    signerWritable(params.payer), //  0
    readonly(configPda), //  1
    writable(params.outboxItem), //  2
    readonly(registeredTransceiverPda), //  3  transceiver (NTT IDL)
    writable(wormholeMessage), //  4  wormhole_message (must be writable — NTT v3 inits this)
    readonly(emitter), //  5
    writable(params.wormholeBridge), //  6  wormhole.bridge
    writable(params.wormholeFeeCollector), //  7  wormhole.fee_collector
    writable(params.wormholeSequence), //  8  wormhole.sequence
    readonly(params.wormholeProgram), //  9  wormhole.program
    readonly(SystemProgram.programId), // 10  wormhole.system_program
    readonly(SYSVAR_CLOCK_PUBKEY), // 11  wormhole.clock
    readonly(SYSVAR_RENT_PUBKEY), // 12  wormhole.rent
    readonly(params.nttProgramId), // 13  manager (v3)
    readonly(params.outboxItemSigner), // 14  outbox_item_signer (v3)
  ]
}

/** Inputs for `buildNttRedeemReleaseAccounts`. Caller resolves the authority/recipient ATA. */
export interface BuildNttRedeemReleaseAccountsParams {
  mint: PublicKey
  nttInboxItem: PublicKey
  nttTransceiverMessage: PublicKey
  ntt: NttRedeemContext
  programId: PublicKey
  /** PDA that signs the redeem+release CPIs (relayer authority on this stack). */
  authority: PublicKey
  /** Release-leg destination ATA: per-user inbox ATA on deposit, relayer custody on withdraw. */
  recipientAta: PublicKey
}

/**
 * Concatenated `redeem ‖ NTT ‖ release ‖ NTT` account list for `receive`.
 * Source chain is pinned to FOGO — the relayer supports no other source,
 * and a chain override would build peer/rate-limit PDAs the on-chain code
 * can never match.
 *
 *   Redeem (10):  authority, config, peer, validatedMsg, registeredTransceiver,
 *                 mint, inboxItem(mut), inboxRateLimit(mut),
 *                 outboxRateLimit(mut), systemProgram
 *   Release (8):  authority, config, inboxItem(mut), recipientAta(mut),
 *                 tokenAuthority, mint(mut), tokenProgram, custody(mut)
 */
export function buildNttRedeemReleaseAccounts(
  params: BuildNttRedeemReleaseAccountsParams,
): { remainingAccounts: AccountMeta[], redeemAccountsLen: number } {
  const fromChain = FOGO_WORMHOLE_CHAIN_ID
  const [configPda] = findNttConfigPda(params.programId)
  const [peerPda] = findNttPeerPda(fromChain, params.programId)
  const [registeredTransceiverPda] = findRegisteredTransceiverPda(
    params.ntt.transceiverAddress,
    params.programId,
  )
  const [inboxRateLimitPda] = findInboxRateLimitPda(fromChain, params.programId)
  const [outboxRateLimitPda] = findOutboxRateLimitPda(params.programId)
  const [tokenAuthorityPda] = findTokenAuthorityPda(params.programId)
  const custody = findNttCustodyAta(params.mint, params.programId)

  const redeem: AccountMeta[] = [
    writable(params.authority),
    readonly(configPda),
    readonly(peerPda),
    readonly(params.nttTransceiverMessage),
    readonly(registeredTransceiverPda),
    readonly(params.mint),
    writable(params.nttInboxItem),
    writable(inboxRateLimitPda),
    writable(outboxRateLimitPda),
    readonly(SystemProgram.programId),
  ]

  const release: AccountMeta[] = [
    writable(params.authority),
    readonly(configPda),
    writable(params.nttInboxItem),
    writable(params.recipientAta),
    readonly(tokenAuthorityPda),
    writable(params.mint),
    readonly(TOKEN_PROGRAM_ID),
    writable(custody),
  ]

  const nttProgramMeta = readonly(params.programId)
  return {
    remainingAccounts: [...redeem, nttProgramMeta, ...release, nttProgramMeta],
    redeemAccountsLen: redeem.length + 1,
  }
}
