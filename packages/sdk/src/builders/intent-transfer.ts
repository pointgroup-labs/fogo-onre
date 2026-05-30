import type { PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  Ed25519Program,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js'
import { readonly, signerWritable, writable } from '../utils/accountMeta'

/**
 * Wire-format primitives for FOGO `intent_transfer.bridge_ntt_tokens`.
 *
 * Why this exists
 * ---------------
 * The off-the-shelf `bridgeOut` helper in `@fogo/sessions-sdk` hardcodes
 * `recipient_address: walletPublicKey.toBase58()` in the signed intent.
 * For OnRe deposits we need `recipient_address` to be the per-user inbox
 * PDA on Solana (`findUserInboxAuthorityPda(wallet)`), so the relayer
 * can sweep + record the originator. The SDK's `bridgeOut` cannot
 * accommodate that override, so we re-implement the wire format here.
 *
 * Format invariant
 * ----------------
 * The on-chain parser `programs/intent-transfer/src/bridge/message.rs`
 * accepts version `0.2` only and matches the exact prefix string +
 * key/value lines below. Any drift (whitespace, key order, version
 * bump) breaks the deposit path silently. `INTENT_BRIDGE_OUT_MESSAGE`
 * is the byte-identical contract surface — pin the upstream
 * `@fogo/sessions-idls` version when this SDK ships, and add an
 * integration test that round-trips this message through the on-chain
 * deserializer.
 *
 * What's NOT here
 * ---------------
 * - Wormhole executor quote fetch (`signedQuoteBytes`) — caller's job;
 *   webapp uses `@wormhole-foundation/sdk`'s NTT route helpers.
 * - NTT sub-context PDA derivation — caller-supplied via
 *   `NttBridgeSubAccounts`. Webapp computes via Wormhole SDK helpers
 *   that already exist in the prior `bridgeOut` flow.
 * - On-chain nonce fetch — caller passes the next `nonce`. Derive PDA:
 *   `["bridge_ntt_nonce", source_ata.owner]` under intent_transfer.
 */

/**
 * Single-byte instruction discriminator. Intent_transfer uses non-Anchor
 * 1-byte tags (NOT sha256 sighash). Confirmed against IDL `discriminator: [1]`
 * for `bridge_ntt_tokens`.
 */
const BRIDGE_NTT_TOKENS_DISCRIMINATOR = 0x01

/** Pinned by upstream parser `version: 0.2`. */
const INTENT_VERSION_MAJOR = 0
const INTENT_VERSION_MINOR = 2

const BRIDGE_OUT_MESSAGE_HEADER
  = 'Fogo Bridge Transfer:\nSigning this intent will bridge out the tokens as described below.\n'

export interface BuildBridgeOutIntentMessageParams {
  /** `fogo` for OnRe deposits. */
  fromChainId: string
  /** `solana` for OnRe deposits. */
  toChainId: string
  /** Token symbol (preferred, from Metaplex metadata) or mint base58. */
  tokenSymbolOrMint: string
  /** Decimal-string amount in human units (e.g. `'12.500000'` for 12.5 USDC). */
  amount: string
  /** Solana-side recipient — for OnRe, the user-inbox PDA. */
  recipientAddress: PublicKey
  /** Fee token symbol or mint base58. */
  feeTokenSymbolOrMint: string
  /** Decimal-string fee amount in fee-token human units. */
  feeAmount: string
  /** Monotonic per-(intent_transfer, source-ATA-owner) counter — fetch on-chain. */
  nonce: bigint
}

/**
 * Encode the bridge-out intent message exactly as the on-chain parser
 * `BridgeMessage::TryFrom<Vec<u8>>` expects. Output is the bytes the
 * user signs with their wallet.
 */
export function buildBridgeOutIntentMessage(
  params: BuildBridgeOutIntentMessageParams,
): Uint8Array {
  const lines = [
    BRIDGE_OUT_MESSAGE_HEADER,
    `version: ${INTENT_VERSION_MAJOR}.${INTENT_VERSION_MINOR}`,
    `from_chain_id: ${params.fromChainId}`,
    `to_chain_id: ${params.toChainId}`,
    `token: ${params.tokenSymbolOrMint}`,
    `amount: ${params.amount}`,
    `recipient_address: ${params.recipientAddress.toBase58()}`,
    `fee_token: ${params.feeTokenSymbolOrMint}`,
    `fee_amount: ${params.feeAmount}`,
    `nonce: ${params.nonce.toString()}`,
  ]
  return new TextEncoder().encode(lines.join('\n'))
}

/**
 * Wrap a signed intent in the SVM `Ed25519Program` native verifier
 * instruction. The wallet signature must precede `bridge_ntt_tokens`
 * in the same transaction; the on-chain handler reads
 * `Sysvar1nstructions` to pull this signature back out and verify it
 * against the intent message.
 */
export function buildIntentVerifierIx(
  walletPublicKey: PublicKey,
  signature: Uint8Array,
  message: Uint8Array,
): TransactionInstruction {
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: walletPublicKey.toBytes(),
    signature,
    message,
  })
}

/**
 * NTT sub-account context. All entries are caller-derived:
 * - PDAs: via Wormhole NTT SDK (`NTT.pdas`, `NTT.transceiverPdas`,
 *   `NTT.custodyAccountAddress`).
 * - `payeeNttWithExecutor`: from the signed-quote payee address.
 * - `nttOutboxItem`: fresh ephemeral keypair pubkey (caller adds the
 *   `Keypair` to the tx's `extraSigners`).
 * - `nttSessionAuthority`: derived against `intent_transfer_setter`
 *   (NOT the user wallet) since intent_transfer's intermediate ATA owner
 *   is the setter PDA.
 */
export interface NttBridgeSubAccounts {
  nttManager: PublicKey
  nttConfig: PublicKey
  nttInboxRateLimit: PublicKey
  nttSessionAuthority: PublicKey
  nttTokenAuthority: PublicKey
  wormholeMessage: PublicKey
  transceiver: PublicKey
  emitter: PublicKey
  wormholeBridge: PublicKey
  wormholeFeeCollector: PublicKey
  wormholeSequence: PublicKey
  wormholeProgram: PublicKey
  nttWithExecutorProgram: PublicKey
  executorProgram: PublicKey
  nttPeer: PublicKey
  nttOutboxItem: PublicKey
  nttOutboxRateLimit: PublicKey
  nttCustody: PublicKey
  payeeNttWithExecutor: PublicKey
}

export interface BuildBridgeNttIxParams {
  /**
   * Which `intent_transfer` program to target. Required and explicit —
   * there is no default, so a caller can never silently route to the
   * dormant Fogo program. Deposit/redeem pass `ONRE_INTENT_PROGRAM_ID`.
   */
  intentTransferProgramId: PublicKey

  // Common accounts
  fromChainId: PublicKey
  intentTransferSetter: PublicKey
  source: PublicKey
  intermediateTokenAccount: PublicKey
  mint: PublicKey
  metadata: PublicKey | null
  expectedNttConfig: PublicKey
  nonce: PublicKey
  sponsor: PublicKey
  feeSource: PublicKey
  feeDestination: PublicKey
  feeMint: PublicKey
  feeMetadata: PublicKey | null
  feeConfig: PublicKey

  // NTT sub-context
  ntt: NttBridgeSubAccounts

  /** Wormhole executor signed quote — exactly 165 bytes. */
  signedQuoteBytes: Uint8Array
  /** True iff destination ATA does not yet exist on Solana. */
  payDestinationAtaRent: boolean
}

/**
 * Build the `bridge_ntt_tokens` instruction. Account order mirrors the
 * IDL exactly (top-level then `ntt` sub-struct flattened in declared
 * order).
 */
export function buildBridgeNttTokensIx(
  params: BuildBridgeNttIxParams,
): TransactionInstruction {
  if (params.signedQuoteBytes.length !== 165) {
    throw new Error(
      `signedQuoteBytes must be exactly 165 bytes, got ${params.signedQuoteBytes.length}`,
    )
  }
  const programId = params.intentTransferProgramId

  const PUBKEY_NULL = SystemProgram.programId // sentinel for `Option<None>` Anchor accounts

  const keys = [
    // Top-level (IDL order)
    readonly(params.fromChainId),
    readonly(SYSVAR_INSTRUCTIONS_PUBKEY),
    readonly(params.intentTransferSetter),
    writable(params.source),
    writable(params.intermediateTokenAccount),
    writable(params.mint),
    readonly(params.metadata ?? PUBKEY_NULL),
    readonly(params.expectedNttConfig),
    writable(params.nonce),
    signerWritable(params.sponsor),
    writable(params.feeSource),
    writable(params.feeDestination),
    readonly(params.feeMint),
    readonly(params.feeMetadata ?? PUBKEY_NULL),
    readonly(params.feeConfig),
    readonly(SystemProgram.programId),
    readonly(TOKEN_PROGRAM_ID),
    readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
    // NTT sub-struct (IDL order)
    readonly(SYSVAR_CLOCK_PUBKEY),
    readonly(SYSVAR_RENT_PUBKEY),
    readonly(params.ntt.nttManager),
    readonly(params.ntt.nttConfig),
    writable(params.ntt.nttInboxRateLimit),
    readonly(params.ntt.nttSessionAuthority),
    readonly(params.ntt.nttTokenAuthority),
    writable(params.ntt.wormholeMessage),
    readonly(params.ntt.transceiver),
    readonly(params.ntt.emitter),
    writable(params.ntt.wormholeBridge),
    writable(params.ntt.wormholeFeeCollector),
    writable(params.ntt.wormholeSequence),
    readonly(params.ntt.wormholeProgram),
    readonly(params.ntt.nttWithExecutorProgram),
    readonly(params.ntt.executorProgram),
    readonly(params.ntt.nttPeer),
    { pubkey: params.ntt.nttOutboxItem, isSigner: true, isWritable: true },
    writable(params.ntt.nttOutboxRateLimit),
    writable(params.ntt.nttCustody),
    writable(params.ntt.payeeNttWithExecutor),
  ]

  // BorshSerialize(BridgeNttTokensArgs) = signed_quote_bytes ([u8; 165]) + pay_destination_ata_rent (u8)
  const data = Buffer.alloc(1 + 165 + 1)
  data[0] = BRIDGE_NTT_TOKENS_DISCRIMINATOR
  data.set(params.signedQuoteBytes, 1)
  data[1 + 165] = params.payDestinationAtaRent ? 1 : 0

  return new TransactionInstruction({ programId, keys, data })
}
