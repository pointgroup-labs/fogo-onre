import type { PublicKey } from '@solana/web3.js'
import type { NttTransferArgs } from './ntt'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { SOLANA_WORMHOLE_CHAIN_ID } from '../constants'
import { readonly, signerWritable, writable } from '../utils/accountMeta'
import { ixDiscriminator } from '../utils/discriminators'
import {
  encodeNttTransferArgsBorsh,
  findInboxRateLimitPda,
  findNttConfigPda,
  findNttCustodyAta,
  findNttPeerPda,
  findOutboxRateLimitPda,
  findSessionAuthorityPda,
  findTokenAuthorityPda,
  nttTransferArgsHash,
} from './ntt'

/** NTT v1 burning-mode `transfer_burn` Anchor sighash. Cached at module init. */
const TRANSFER_BURN_DISCRIMINATOR = ixDiscriminator('transfer_burn')

export interface BuildFogoNttTransferParams {
  /** User's FOGO wallet — signer; encoded as `NttManagerMessage.sender`. */
  payer: PublicKey
  /** FOGO-side NTT manager program ID for this mint (USDC.s or ONyc). */
  nttManagerProgramId: PublicKey
  /** Bridged mint on FOGO (USDC.s for deposit, ONyc for withdraw). */
  mint: PublicKey
  /**
   * Fresh ephemeral keypair pubkey used as the `outbox_item`. The caller
   * MUST add the matching `Keypair` to the transaction's signer set —
   * NTT `init`s the account, so it must sign at submission.
   */
  outboxItem: PublicKey
  /** Amount in mint base units (USDC.s = 6 decimals, ONyc = 9). */
  amount: bigint
  /**
   * Solana-side recipient — the relayer authority PDA for both legs (see
   * `findAuthorityPda`). The relayer is the only address that can crank
   * the Solana side; routing user funds anywhere else would orphan them.
   */
  recipientOnSolana: PublicKey
  /**
   * Optional override for the source token account. Defaults to the
   * payer's ATA for `mint`.
   */
  fromTokenAccount?: PublicKey
  /** NTT outbound queue toggle. Defaults false (immediate send). */
  shouldQueue?: boolean
}

/**
 * Build the FOGO NTT `transfer_burn` instruction. Account order mirrors
 * the upstream `TransferBurn` Anchor struct: the embedded `Transfer`
 * common struct (9 accounts) is flattened first, then the burn-specific
 * accounts (4) are appended.
 */
function buildFogoNttTransferBurnIx(
  params: BuildFogoNttTransferParams,
): TransactionInstruction {
  const shouldQueue = params.shouldQueue ?? false
  const recipientChain = SOLANA_WORMHOLE_CHAIN_ID
  const fromTokenAccount = params.fromTokenAccount
    ?? getAssociatedTokenAddressSync(params.mint, params.payer)

  const [configPda] = findNttConfigPda(params.nttManagerProgramId)
  const [outboxRateLimitPda] = findOutboxRateLimitPda(params.nttManagerProgramId)
  const [inboxRateLimitPda] = findInboxRateLimitPda(recipientChain, params.nttManagerProgramId)
  const [peerPda] = findNttPeerPda(recipientChain, params.nttManagerProgramId)
  const [tokenAuthorityPda] = findTokenAuthorityPda(params.nttManagerProgramId)
  const custody = findNttCustodyAta(params.mint, params.nttManagerProgramId)

  const args: NttTransferArgs = {
    amount: params.amount,
    recipientChain,
    recipientAddress: params.recipientOnSolana.toBuffer(),
    shouldQueue,
  }
  const [sessionAuthorityPda] = findSessionAuthorityPda(
    params.payer,
    nttTransferArgsHash(args),
    params.nttManagerProgramId,
  )

  const keys = [
    signerWritable(params.payer),
    readonly(configPda),
    writable(params.mint),
    writable(fromTokenAccount),
    readonly(TOKEN_PROGRAM_ID),
    signerWritable(params.outboxItem),
    writable(outboxRateLimitPda),
    writable(custody),
    readonly(SystemProgram.programId),
    writable(inboxRateLimitPda),
    readonly(peerPda),
    readonly(sessionAuthorityPda),
    readonly(tokenAuthorityPda),
  ]

  const argsBytes = encodeNttTransferArgsBorsh(args)
  const data = Buffer.alloc(TRANSFER_BURN_DISCRIMINATOR.length + argsBytes.length)
  data.set(TRANSFER_BURN_DISCRIMINATOR, 0)
  data.set(argsBytes, TRANSFER_BURN_DISCRIMINATOR.length)

  return new TransactionInstruction({ programId: params.nttManagerProgramId, keys, data })
}

/**
 * FOGO NTT `transfer_burn` initiating a deposit (USDC.s burned on FOGO →
 * Solana USDC custody released to the relayer authority PDA). The relayer
 * cranks `claim_usdc` → `swap_usdc_to_onyc` → `lock_onyc`, ultimately
 * delivering ONyc back to `payer` via the ONyc NTT manager.
 */
export function buildFogoNttDepositIx(
  params: BuildFogoNttTransferParams,
): TransactionInstruction {
  return buildFogoNttTransferBurnIx(params)
}

/**
 * FOGO NTT `transfer_burn` initiating a withdraw (ONyc burned on FOGO →
 * Solana ONyc custody released to the relayer authority PDA). The relayer
 * cranks `unlock_onyc` → `request_redemption_onyc` →
 * `claim_redemption_usdc` → `send_usdc_to_user`, returning USDC.s to
 * `payer` on FOGO.
 */
export function buildFogoNttWithdrawIx(
  params: BuildFogoNttTransferParams,
): TransactionInstruction {
  return buildFogoNttTransferBurnIx(params)
}
