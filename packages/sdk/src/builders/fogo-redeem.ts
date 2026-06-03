import type { PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { SOLANA_WORMHOLE_CHAIN_ID } from '../constants'
import { readonly, signerWritable, writable } from '../utils/accountMeta'
import { ixDiscriminator } from '../utils/discriminators'
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
 * Standalone (non-CPI) FOGO-side ONyc redemption pair: `redeem` (writes
 * the inbox item) + `release_inbound_{mint,unlock}` (mints or unlocks ONyc
 * to the user's FOGO ATA). Caller picks the `_mint`/`_unlock` variant from
 * `Config.mode` (a deploy-time invariant). Source chain is pinned to Solana
 * — anything else yields PDAs the manager can't validate.
 */

const REDEEM_DISCRIMINATOR = ixDiscriminator('redeem')
const RELEASE_INBOUND_MINT_DISCRIMINATOR = ixDiscriminator('release_inbound_mint')
const RELEASE_INBOUND_UNLOCK_DISCRIMINATOR = ixDiscriminator('release_inbound_unlock')

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
 * Build the NTT v3 `redeem` instruction. IDL pin (v3.0.0): 10 accounts in
 * order — payer(mut,signer), config, peer, transceiverMessage, transceiver,
 * mint, inboxItem(mut), inboxRateLimit(mut), outboxRateLimit(mut), systemProgram.
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
    signerWritable(params.payer),
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
 * Build the NTT v3 `release_inbound_mint` instruction (Burning mode). IDL
 * pin: 8 accounts — payer(mut,signer), config, inboxItem(mut), recipient(mut),
 * tokenAuthority, mint(mut), tokenProgram, custody(mut).
 */
export function buildFogoNttReleaseInboundMintIx(
  params: BuildFogoNttReleaseInboundIxParams,
): TransactionInstruction {
  return buildReleaseInboundIx(params, RELEASE_INBOUND_MINT_DISCRIMINATOR)
}

/** Build the NTT v3 `release_inbound_unlock` instruction (Locking mode); same 8-account layout as `release_inbound_mint`. */
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
    signerWritable(params.payer),
    readonly(configPda),
    writable(params.nttInboxItem),
    writable(params.recipientAta),
    readonly(tokenAuthorityPda),
    writable(params.mint),
    readonly(TOKEN_PROGRAM_ID),
    writable(custody),
  ]

  const data = Buffer.alloc(discriminator.length + 1)
  data.set(discriminator, 0)
  data[discriminator.length] = (params.revertWhenNotReady ?? false) ? 1 : 0

  return new TransactionInstruction({ programId: params.nttManagerProgramId, keys, data })
}
