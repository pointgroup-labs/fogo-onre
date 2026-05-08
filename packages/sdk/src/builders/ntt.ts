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
import { readonly, writable } from '../utils/accountMeta'

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

/**
 * NTT's `Config.custody` is set during `initialize` via the
 * `associated_token::mint = mint, associated_token::authority =
 * token_authority` Anchor constraints — i.e. the (possibly off-curve) ATA
 * of the manager's `token_authority` PDA for the bridged mint. Because
 * `initialize` is the only writer of `Config.custody` and the constraint
 * pins the address, custody is fully derivable from `(mint, programId)`
 * without an RPC fetch. Verified against FOGO mainnet USDC.s
 * (`uSd2czE…` / manager `nttu74…` → custody `F1dShvAq…`).
 */
export function findNttCustodyAta(
  mint: PublicKey,
  programId: PublicKey,
): PublicKey {
  const [tokenAuthorityPda] = findTokenAuthorityPda(programId)
  return getAssociatedTokenAddressSync(mint, tokenAuthorityPda, true)
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
  programId: PublicKey,
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
export interface NttTransferArgs {
  amount: bigint
  recipientChain: number
  recipientAddress: Uint8Array
  shouldQueue: boolean
}

/**
 * Shared 43-byte buffer-builder for `TransferArgs`. The on-chain
 * `keccak256()` hash uses big-endian; the Borsh-encoded instruction
 * data uses little-endian. Same field layout otherwise — extracting
 * here removes the duplicated body and the duplicated 32-byte
 * recipient-address validation.
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

/**
 * Borsh-encode `TransferArgs` for the NTT instruction `data` payload.
 * Distinct from `nttTransferArgsHash`: borsh is little-endian, ChainId is
 * a single u16 field, and the encoder produces 43 bytes (no discriminator).
 */
export function encodeNttTransferArgsBorsh(args: NttTransferArgs): Uint8Array {
  return serializeTransferArgs(args, true)
}

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
}

/**
 * Build the 14-entry account list expected by NTT v1's outbound
 * `transfer_lock` instruction. Mode-, mint-, and program-id-agnostic — the
 * relayer's Solana-side `lock_onyc` / `send_usdc_to_user` use it under the
 * canonical per-leg NTT program ID (USDC.s or ONyc) with the relayer authority PDA as the
 * non-signer source owner; FOGO-side user-signed flows use it with the
 * FOGO NTT manager program ID and the user's wallet as a signer source.
 *
 * The order matches the NTT v1 `TransferLock` Anchor accounts struct
 * (verified against the relayer's Rust `lock_onyc` handler). Reordering
 * any entry silently breaks the CPI — keep these in lockstep with NTT
 * upstream.
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

/**
 * Account count for the NTT `transfer_lock` instruction. The handler
 * unpacks exactly this many trailing accounts; the relayer instructions
 * (`lockOnyc`, `sendUsdcToUser`) pass it as the split-marker so the
 * on-chain program knows where the NTT slice ends and the next builder
 * (release-wormhole-outbound) begins.
 */
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
    { pubkey: params.fromOwner, isSigner: params.fromOwnerIsSigner, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: params.mint, isSigner: false, isWritable: true },
    { pubkey: params.fromTokenAccount, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: params.outboxItem, isSigner: true, isWritable: true },
    { pubkey: outboxRateLimitPda, isSigner: false, isWritable: true },
    { pubkey: custody, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: inboxRateLimitPda, isSigner: false, isWritable: true },
    { pubkey: peerPda, isSigner: false, isWritable: false },
    { pubkey: sessionAuthorityPda, isSigner: false, isWritable: false },
    { pubkey: tokenAuthorityPda, isSigner: false, isWritable: false },
    { pubkey: params.nttProgramId, isSigner: false, isWritable: false },
  ]
  if (accounts.length !== NTT_TRANSFER_LOCK_ACCOUNT_COUNT) {
    throw new Error(
      `NTT transfer_lock account list drift: expected ${NTT_TRANSFER_LOCK_ACCOUNT_COUNT}, got ${accounts.length}`,
    )
  }
  return accounts
}

/**
 * NTT transceiver-emitter PDA: `["emitter"]` under the transceiver
 * program ID. For the OnRe stack, the manager program *is* the
 * transceiver, so callers pass `nttProgramId` here.
 */
export function findNttEmitterPda(
  transceiverProgramId: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([EMITTER_SEED], transceiverProgramId)
}

/**
 * Per-outbox Wormhole message PDA: `["message", outbox_item]` under the
 * transceiver program ID. NTT v3 init's this account during
 * `release_wormhole_outbound`, so it must be writable.
 */
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
 * Inputs for the NTT v3 outbound publish step
 * (`release_wormhole_outbound`). This is the *second* CPI in a
 * lock-then-publish flow on the relayer side: `transfer_lock` mints the
 * outbox item, `release_wormhole_outbound` posts it to Wormhole Core.
 *
 * Mainnet-verified ordering & writability via tx `3NR6EEbk…`'s top-level
 * accounts array (15 entries, manager + outbox_item_signer at the v3
 * tail, system/clock/rent grouped inside the wormhole composite, NOT at
 * the tail).
 *
 * Wormhole Core PDAs (`bridge`, `fee_collector`, `sequence`) are
 * caller-supplied because their derivation depends on the deployed
 * Wormhole Core program ID — we deliberately don't hardcode that here
 * to keep the SDK cluster-agnostic.
 */
export interface BuildNttReleaseWormholeOutboundAccountListParams {
  /** Permissionless cranker (signs + pays). */
  payer: PublicKey
  /** NTT manager program id (USDC.s or ONyc on Solana). */
  nttProgramId: PublicKey
  /**
   * NTT manager-as-transceiver program id. For the OnRe stack this is
   * the same as `nttProgramId`; kept separate to match upstream NTT's
   * "manager ≠ transceiver" generality and future-proof against a split.
   */
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
  /**
   * NTT v3 outbox-item signer PDA (per upstream NTT v3 release ABI).
   * Caller derives via Wormhole NTT SDK.
   */
  outboxItemSigner: PublicKey
}

/**
 * Build the 15-entry account list for NTT v3
 * `release_wormhole_outbound`. Order matches mainnet tx `3NR6EEbk…`
 * exactly — see `BuildNttReleaseWormholeOutboundAccountListParams`
 * docs. Reordering silently breaks the CPI.
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
    { pubkey: params.payer, isSigner: true, isWritable: true }, //  0
    { pubkey: configPda, isSigner: false, isWritable: false }, //  1
    { pubkey: params.outboxItem, isSigner: false, isWritable: true }, //  2
    { pubkey: registeredTransceiverPda, isSigner: false, isWritable: false }, //  3  transceiver (NTT IDL)
    { pubkey: wormholeMessage, isSigner: false, isWritable: true }, //  4  wormhole_message (must be writable — NTT v3 inits this)
    { pubkey: emitter, isSigner: false, isWritable: false }, //  5
    { pubkey: params.wormholeBridge, isSigner: false, isWritable: true }, //  6  wormhole.bridge
    { pubkey: params.wormholeFeeCollector, isSigner: false, isWritable: true }, //  7  wormhole.fee_collector
    { pubkey: params.wormholeSequence, isSigner: false, isWritable: true }, //  8  wormhole.sequence
    { pubkey: params.wormholeProgram, isSigner: false, isWritable: false }, //  9  wormhole.program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 10  wormhole.system_program
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false }, // 11  wormhole.clock
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // 12  wormhole.rent
    { pubkey: params.nttProgramId, isSigner: false, isWritable: false }, // 13  manager (v3)
    { pubkey: params.outboxItemSigner, isSigner: false, isWritable: false }, // 14  outbox_item_signer (v3)
  ]
}

/**
 * Inputs for `buildNttRedeemReleaseAccounts`. Caller resolves the
 * authority/recipient ATA so this function stays free of `RelayerClient`
 * coupling — it lives next to the other NTT account-meta builders.
 */
export interface BuildNttRedeemReleaseAccountsParams {
  mint: PublicKey
  nttInboxItem: PublicKey
  nttTransceiverMessage: PublicKey
  ntt: NttRedeemContext
  programId: PublicKey
  /** PDA that signs the redeem+release CPIs (relayer authority on this stack). */
  authority: PublicKey
  /** Destination ATA for the release leg. Caller picks per-instruction:
   *  `claim_usdc` routes to the per-user inbox ATA, `unlock_onyc` routes
   *  to the long-lived relayer custody ATA. */
  recipientAta: PublicKey
}

/**
 * Build the concatenated `redeem ‖ release ‖ NTT program` account list
 * for `claim_usdc` / `unlock_onyc`. Mint-agnostic — caller supplies the
 * NTT-managed mint (USDC.s on the deposit leg, ONyc on the withdraw leg).
 *
 *   Redeem (10):  payer, config, peer, validatedMsg, registeredTransceiver,
 *                 mint, inboxItem(mut), inboxRateLimit(mut),
 *                 outboxRateLimit(mut), systemProgram
 *   Release (8):  payer, config, inboxItem(mut), recipientAta(mut),
 *                 tokenAuthority, mint(mut), tokenProgram, custody(mut)
 *   + NTT program appended after each slice (for invoke_signed resolution)
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
