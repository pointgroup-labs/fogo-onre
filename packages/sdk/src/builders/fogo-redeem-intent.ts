import type { PublicKey, TransactionInstruction } from '@solana/web3.js'
import type {
  BuildBridgeNttIxParams,
  BuildBridgeOutIntentMessageParams,
} from './intent-transfer'
import { ONRE_INTENT_PROGRAM_ID, RELAYER_PROGRAM_ID } from '../constants'
import { findUserInboxWithMinPda } from '../pda'
import {
  buildBridgeNttTokensIx,
  buildBridgeOutIntentMessage,
  buildIntentVerifierIx,
} from './intent-transfer'
import { buildMinSwapOutMemoIx } from './min-out-memo'

/**
 * Intent-based ONyc redeem (withdraw): bridges ONyc FOGO→Solana through
 * the OnRe `intent_transfer` fork's `bridge_ntt_tokens`, a hard mirror of
 * the deposit leg.
 *
 * The signed-intent `recipient_address` is pinned to the min-bearing
 * inbox PDA (`[USER_INBOX_SEED, userWallet, minSwapOut]`
 * under the relayer), committing the user-signed swap floor. On Solana the
 * relayer's `receive` pins the VTM sender to the {OnRe, Fogo} setter
 * allowlist, re-derives the same PDA from `(userWallet, minSwapOut)`, sweeps
 * the released ONyc into custody, and records `flow.recipient = userWallet`
 * for the return leg.
 *
 * Composes the deposit primitives (`buildBridgeOutIntentMessage` +
 * `buildIntentVerifierIx` + `buildBridgeNttTokensIx`) parameterized for
 * the ONyc mint and the redeem recipient.
 */
export interface BuildFogoRedeemIntentParams {
  /** Originating FOGO wallet that signs the intent. */
  userWallet: PublicKey
  /** Wallet-adapter `signMessage`; signs the intent bytes verbatim. */
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
  /** Intent metadata minus the recipient, which we derive from `userWallet`. */
  intent: Omit<BuildBridgeOutIntentMessageParams, 'recipientAddress'>
  /** Swap floor (output-token atomic units); committed into the recipient PDA. */
  minSwapOut: bigint
  /** `bridge_ntt_tokens` accounts minus the program id (defaulted to the fork). */
  bridge: Omit<BuildBridgeNttIxParams, 'intentTransferProgramId'>
  /** Defaults to `ONRE_INTENT_PROGRAM_ID`; pass Fogo's id for switch-back. */
  intentTransferProgramId?: PublicKey
  /** Relayer program for inbox-PDA derivation. Defaults to `RELAYER_PROGRAM_ID`. */
  relayerProgramId?: PublicKey
}

export interface FogoRedeemIntentResult {
  /** Min-bearing per-user inbox PDA embedded as the intent recipient. */
  recipientAddress: PublicKey
  /** Signed intent bytes (carried by the verifier ix). */
  message: Uint8Array
  verifierIx: TransactionInstruction
  bridgeIx: TransactionInstruction
  /** SPL Memo `onre:mso:<n>` — the cranker's `min_out` read source. */
  memoIx: TransactionInstruction
  /** `[memoIx, verifierIx, bridgeIx]` — memo first; verifier immediately precedes the bridge ix. */
  ixs: TransactionInstruction[]
}

export async function buildFogoRedeemIntentIx(
  params: BuildFogoRedeemIntentParams,
): Promise<FogoRedeemIntentResult> {
  const intentTransferProgramId = params.intentTransferProgramId ?? ONRE_INTENT_PROGRAM_ID
  const relayerProgramId = params.relayerProgramId ?? RELAYER_PROGRAM_ID

  const [recipientAddress] = findUserInboxWithMinPda(
    params.userWallet,
    params.minSwapOut,
    relayerProgramId,
  )
  const message = buildBridgeOutIntentMessage({ ...params.intent, recipientAddress })
  const signature = await params.signMessage(message)

  const verifierIx = buildIntentVerifierIx(params.userWallet, signature, message)
  const bridgeIx = buildBridgeNttTokensIx({ ...params.bridge, intentTransferProgramId })
  // Same floor the recipient PDA commits — gives the cranker a memo to read.
  // Ordered before the verifier to match the paymaster variation.
  const memoIx = buildMinSwapOutMemoIx(params.minSwapOut)

  return { recipientAddress, message, verifierIx, bridgeIx, memoIx, ixs: [memoIx, verifierIx, bridgeIx] }
}
