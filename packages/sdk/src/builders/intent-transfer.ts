import type { PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  Ed25519Program,
  PublicKey as PublicKeyCtor,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js'
import { readonly, signerWritable, writable } from '../utils/accountMeta'

/**
 * Wire-format primitives for FOGO `intent_transfer.bridge_ntt_tokens`.
 * Re-implemented (not `@fogo/sessions-sdk`'s `bridgeOut`) because OnRe
 * deposits need `recipient_address` = the per-user inbox PDA, which
 * `bridgeOut` can't override.
 *
 * Format invariant: the on-chain parser
 * `programs/intent-transfer/src/bridge/message.rs` accepts version `0.2`
 * only and matches the exact prefix + key/value lines below. Any drift
 * (whitespace, key order, version bump) breaks deposit silently.
 */

/** Non-Anchor 1-byte tag (IDL `discriminator: [1]`), not a sha256 sighash. */
const BRIDGE_NTT_TOKENS_DISCRIMINATOR = 0x01

/** Pinned by upstream parser `version: 0.2`. */
const INTENT_VERSION_MAJOR = 0
const INTENT_VERSION_MINOR = 2

const BRIDGE_OUT_MESSAGE_HEADER
  = 'Fogo Bridge\n'

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
 * `BridgeMessage::TryFrom<Vec<u8>>` expects — the bytes the user signs.
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
 * Wrap a signed intent in the SVM `Ed25519Program` verifier ix. It must
 * precede `bridge_ntt_tokens` in the same tx; the handler reads
 * `Sysvar1nstructions` to recover and verify the signature.
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
 * NTT sub-account context — all caller-derived (Wormhole NTT SDK for PDAs,
 * signed-quote for `payeeNttWithExecutor`, fresh keypair for `nttOutboxItem`).
 * `nttSessionAuthority` derives against `intent_transfer_setter`, not the
 * user wallet — the intermediate ATA owner is the setter PDA.
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
   * Target `intent_transfer` program. Required and explicit — no default,
   * so a caller can never silently route to the dormant Fogo program.
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

  /**
   * Session account (or wallet) authorizing the user-token debits via the
   * FOGO session rail. Signs the transaction; the patched token program
   * checks it against `source.owner`.
   */
  signerOrSession: PublicKey
  /** Per-program signer PDA: `findProgramSignerPda(intentTransferProgramId)`. */
  programSigner: PublicKey

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
    readonly(params.feeConfig),
    writable(params.feeSource),
    writable(params.feeDestination),
    readonly(params.feeMint),
    readonly(params.feeMetadata ?? PUBKEY_NULL),
    readonly(SystemProgram.programId),
    readonly(TOKEN_PROGRAM_ID),
    readonly(ASSOCIATED_TOKEN_PROGRAM_ID),
    { pubkey: params.signerOrSession, isSigner: true, isWritable: false },
    readonly(params.programSigner),
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

/** Non-Anchor 1-byte tag (IDL `discriminator: [5]`). */
const UPDATE_FEE_CONFIG_DISCRIMINATOR = 0x05

const FEE_CONFIG_SEED = Buffer.from('fee_config')
const BPF_LOADER_UPGRADEABLE_ID = new PublicKeyCtor(
  'BPFLoaderUpgradeab1e11111111111111111111111',
)

/** Canonical per-mint `FeeConfig` PDA under a given intent_transfer program. */
export function findFeeConfigPda(
  intentTransferProgramId: PublicKey,
  mint: PublicKey,
): PublicKey {
  return PublicKeyCtor.findProgramAddressSync(
    [FEE_CONFIG_SEED, mint.toBuffer()],
    intentTransferProgramId,
  )[0]
}

export interface BuildUpdateFeeConfigIxParams {
  /** Which intent_transfer program owns the FeeConfig PDA. */
  intentTransferProgramId: PublicKey
  /** Program upgrade authority — signs and pays the realloc. */
  upgradeAuthority: PublicKey
  /** Mint whose FeeConfig is edited (PDA seed). */
  mint: PublicKey
  /** New fee receiver wallet (ATA owner for collected fees). */
  feeRecipient: PublicKey
  /** Intrachain (`send_tokens`) fee in fee-mint base units. */
  intrachainTransferFee: bigint
  /** Bridge (`bridge_ntt_tokens`) fee in fee-mint base units. */
  bridgeTransferFee: bigint
}

/**
 * Build the upgrade-authority-gated `update_fee_config` instruction. Reallocs
 * the existing per-mint FeeConfig PDA to the current size and overwrites all
 * fields, including the appended `fee_recipient`. Used for the live-state
 * migration and any later fee/recipient edit.
 */
export function buildUpdateFeeConfigIx(
  params: BuildUpdateFeeConfigIxParams,
): TransactionInstruction {
  const programId = params.intentTransferProgramId
  const [programData] = PublicKeyCtor.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID,
  )
  const feeConfig = findFeeConfigPda(programId, params.mint)

  const keys = [
    signerWritable(params.upgradeAuthority),
    readonly(programData),
    readonly(params.mint),
    writable(feeConfig),
    readonly(SystemProgram.programId),
  ]

  // disc(1) + BorshSerialize(FeeConfig): u64 LE + u64 LE + Pubkey(32)
  const data = Buffer.alloc(1 + 8 + 8 + 32)
  data[0] = UPDATE_FEE_CONFIG_DISCRIMINATOR
  data.writeBigUInt64LE(params.intrachainTransferFee, 1)
  data.writeBigUInt64LE(params.bridgeTransferFee, 9)
  data.set(params.feeRecipient.toBuffer(), 17)

  return new TransactionInstruction({ programId, keys, data })
}
