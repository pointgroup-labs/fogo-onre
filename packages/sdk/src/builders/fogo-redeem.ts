import type { PublicKey } from '@solana/web3.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { SOLANA_WORMHOLE_CHAIN_ID } from '../constants'
import {
  findInboxRateLimitPda,
  findNttConfigPda,
  findNttCustodyAta,
  findNttPeerPda,
  findOutboxRateLimitPda,
  findRegisteredTransceiverPda,
  findTokenAuthorityPda,
} from './ntt'

/**
 * Standalone (non-CPI) builders for the FOGO-side ONyc redemption pair:
 * `redeem` (writes the inbox item) + `release_inbound_{mint,unlock}`
 * (mints or unlocks ONyc to the user's FOGO ATA).
 *
 * Symmetric to the Solana-side relayer flow: the relayer's `claim_usdc`
 * CPIs into `redeem` + `release_inbound_unlock` for incoming USDC. Here
 * we do the same shape directly (no relayer in the loop) for incoming
 * ONyc on FOGO.
 *
 * Both `_mint` and `_unlock` carry the manager's `custody` ATA (NTT v3
 * IDL field; same shape regardless of mode — burn mode burns from
 * custody as part of release, lock mode unlocks from custody). The
 * caller picks the variant based on `Config.mode` (decoded via
 * `decodeNttConfig`) at startup; mode is a deploy-time invariant on the
 * NTT manager and cannot be flipped at runtime.
 *
 * Source chain is fixed to Solana — the FOGO-side peer/inbox-rate-limit
 * PDAs are seeded by `SOLANA_WORMHOLE_CHAIN_ID`. Anything else yields
 * PDAs the manager can't validate.
 */

const REDEEM_DISCRIMINATOR = sha256(
  new TextEncoder().encode('global:redeem'),
).slice(0, 8)

const RELEASE_INBOUND_MINT_DISCRIMINATOR = sha256(
  new TextEncoder().encode('global:release_inbound_mint'),
).slice(0, 8)

const RELEASE_INBOUND_UNLOCK_DISCRIMINATOR = sha256(
  new TextEncoder().encode('global:release_inbound_unlock'),
).slice(0, 8)

export interface BuildFogoNttRedeemIxParams {
  /** Permissionless caller (signs + pays FOGO gas). */
  payer: PublicKey
  /** FOGO-side ONyc NTT manager program ID. */
  nttManagerProgramId: PublicKey
  /** ONyc mint on FOGO. */
  mint: PublicKey
  /** Per-VAA transceiver message PDA (Anchor `init` on first redeem; idempotent thereafter). */
  nttTransceiverMessage: PublicKey
  /** Per-VAA inbox item PDA (Anchor `init` on first redeem). */
  nttInboxItem: PublicKey
  /** Optional override for the registered transceiver. Defaults to manager-as-transceiver (OnRe pattern). */
  transceiverProgramId?: PublicKey
}

/**
 * Build the NTT v3 `redeem` instruction.
 *
 * IDL pin (`example_native_token_transfers.json` v3.0.0, instruction
 * `redeem`): 10 accounts in order — payer(mut,signer), config, peer,
 * transceiverMessage, transceiver, mint, inboxItem(mut),
 * inboxRateLimit(mut), outboxRateLimit(mut), systemProgram.
 */
export function buildFogoNttRedeemIx(
  params: BuildFogoNttRedeemIxParams,
): TransactionInstruction {
  const transceiverProgramId = params.transceiverProgramId ?? params.nttManagerProgramId
  const [configPda] = findNttConfigPda(params.nttManagerProgramId)
  const [peerPda] = findNttPeerPda(SOLANA_WORMHOLE_CHAIN_ID, params.nttManagerProgramId)
  const [registeredTransceiverPda] = findRegisteredTransceiverPda(
    transceiverProgramId,
    params.nttManagerProgramId,
  )
  const [inboxRateLimitPda] = findInboxRateLimitPda(
    SOLANA_WORMHOLE_CHAIN_ID,
    params.nttManagerProgramId,
  )
  const [outboxRateLimitPda] = findOutboxRateLimitPda(params.nttManagerProgramId)

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: peerPda, isSigner: false, isWritable: false },
    { pubkey: params.nttTransceiverMessage, isSigner: false, isWritable: false },
    { pubkey: registeredTransceiverPda, isSigner: false, isWritable: false },
    { pubkey: params.mint, isSigner: false, isWritable: false },
    { pubkey: params.nttInboxItem, isSigner: false, isWritable: true },
    { pubkey: inboxRateLimitPda, isSigner: false, isWritable: true },
    { pubkey: outboxRateLimitPda, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ]

  const data = Buffer.alloc(REDEEM_DISCRIMINATOR.length)
  data.set(REDEEM_DISCRIMINATOR, 0)

  return new TransactionInstruction({ programId: params.nttManagerProgramId, keys, data })
}

export interface BuildFogoNttReleaseInboundIxParams {
  /** Permissionless caller (signs + pays FOGO gas). Must match the redeem payer. */
  payer: PublicKey
  /** FOGO-side ONyc NTT manager program ID. */
  nttManagerProgramId: PublicKey
  /** ONyc mint on FOGO. */
  mint: PublicKey
  /** Per-VAA inbox item PDA — same as redeem. */
  nttInboxItem: PublicKey
  /**
   * Recipient ATA on FOGO (user's ONyc ATA). Caller must ensure this
   * exists; pair with `createAssociatedTokenAccountIdempotent` upstream.
   */
  recipientAta: PublicKey
  /**
   * NTT `revertWhenNotReady` arg. Defaults false — when the inbox item's
   * `releaseStatus` is `ReleaseAfter(ts)` and the timestamp hasn't passed,
   * the handler returns `Ok(())` (no-op) instead of erroring. true makes
   * the call revert in that case.
   */
  revertWhenNotReady?: boolean
}

/**
 * Build the NTT v3 `release_inbound_mint` instruction (Burning mode).
 *
 * IDL pin (instruction `releaseInboundMint`, accounts.common): 8
 * required accounts in order — payer(mut,signer), config, inboxItem(mut),
 * recipient(mut), tokenAuthority, mint(mut), tokenProgram, custody(mut).
 * The optional `multisigTokenAuthority` is omitted (not used by the
 * standard single-signer manager deploy).
 */
export function buildFogoNttReleaseInboundMintIx(
  params: BuildFogoNttReleaseInboundIxParams,
): TransactionInstruction {
  return buildReleaseInboundIx(params, RELEASE_INBOUND_MINT_DISCRIMINATOR)
}

/**
 * Build the NTT v3 `release_inbound_unlock` instruction (Locking mode).
 *
 * IDL pin (instruction `releaseInboundUnlock`, accounts.common): same
 * 8-account layout as `release_inbound_mint`.
 */
export function buildFogoNttReleaseInboundUnlockIx(
  params: BuildFogoNttReleaseInboundIxParams,
): TransactionInstruction {
  return buildReleaseInboundIx(params, RELEASE_INBOUND_UNLOCK_DISCRIMINATOR)
}

function buildReleaseInboundIx(
  params: BuildFogoNttReleaseInboundIxParams,
  discriminator: Uint8Array,
): TransactionInstruction {
  const [configPda] = findNttConfigPda(params.nttManagerProgramId)
  const [tokenAuthorityPda] = findTokenAuthorityPda(params.nttManagerProgramId)
  const custody = findNttCustodyAta(params.mint, params.nttManagerProgramId)

  const keys = [
    { pubkey: params.payer, isSigner: true, isWritable: true },
    { pubkey: configPda, isSigner: false, isWritable: false },
    { pubkey: params.nttInboxItem, isSigner: false, isWritable: true },
    { pubkey: params.recipientAta, isSigner: false, isWritable: true },
    { pubkey: tokenAuthorityPda, isSigner: false, isWritable: false },
    { pubkey: params.mint, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: custody, isSigner: false, isWritable: true },
  ]

  const data = Buffer.alloc(discriminator.length + 1)
  data.set(discriminator, 0)
  data[discriminator.length] = (params.revertWhenNotReady ?? false) ? 1 : 0

  return new TransactionInstruction({ programId: params.nttManagerProgramId, keys, data })
}

// Back-compat alias for the previous, narrower param interface name.
export type BuildFogoNttReleaseInboundMintIxParams = BuildFogoNttReleaseInboundIxParams
