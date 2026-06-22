import { Buffer } from 'node:buffer'
import { PublicKey } from '@solana/web3.js'
import IDL from './idl/fogo_ntt_relayer.json' with { type: 'json' }

export const SOLANA_WORMHOLE_CHAIN_ID = 1
export const FOGO_WORMHOLE_CHAIN_ID = 51

export const RELAYER_PROGRAM_ID = new PublicKey(IDL.address)
export const ONRE_PROGRAM_ID = new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe')

/** NTT manager program for USDC.s on Solana mainnet. */
export const NTT_USDC_PROGRAM_ID = new PublicKey('nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk')

/** NTT manager program for ONyc on Solana mainnet. */
export const NTT_ONYC_PROGRAM_ID = new PublicKey('nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd')

/**
 * Wormhole NTT-transceiver program for ONyc — a deliberate alias of the
 * manager. NTT v3 *bundled* mode runs the transceiver inside the manager, so
 * all transceiver-side PDAs key on the manager's program ID.
 */
export const WH_TRANSCEIVER_ONYC_PROGRAM_ID = NTT_ONYC_PROGRAM_ID

/** OnRe's ONyc SPL mint on Solana mainnet. */
export const ONYC_MINT = new PublicKey('5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5')

/** NTT-bridged ONyc mint on FOGO — the `FeeConfig` seed for the redeem leg. */
export const FOGO_ONYC_MINT = new PublicKey('oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa')

/** Canonical USDC on Solana mainnet — the Solana-side counterpart of FOGO USDC.s. */
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

export const GLOBAL_CONFIG_SEED = Buffer.from('global_config')
export const CONFIG_SEED = Buffer.from('relayer_config')
export const RELAYER_SEED = Buffer.from('relayer')
export const FLOW_INBOUND_SEED = Buffer.from('inflight')
export const FLOW_OUTBOUND_SEED = Buffer.from('outflight')
export const NTT_SESSION_AUTHORITY_SEED = Buffer.from('session_authority')

/**
 * Min-bearing inbox PDA seed. Full seeds:
 * `[USER_INBOX_SEED, wallet, minOut.to_le_bytes()]`.
 * Commits the user-signed swap floor into the NTT `recipient_address`.
 */
export const USER_INBOX_SEED = Buffer.from('user_inbox')

/** Refund timeout in slots. Mirrors on-chain `REFUND_TIMEOUT_SLOTS = 54_000`. */
export const REFUND_TIMEOUT_SLOTS = 54_000n

/**
 * FOGO `intent_transfer` program ID. Webapp routes deposit `bridge_ntt_tokens`
 * here; the relayer pins it as a valid VAA originator via the setter PDA.
 */
export const INTENT_TRANSFER_PROGRAM_ID = new PublicKey('Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD')

/**
 * OnRe fork of Fogo's `intent_transfer` (source-identical, `declare_id!` only).
 * Deposit + redeem route here once activated; `INTENT_TRANSFER_PROGRAM_ID` kept
 * for switch-back.
 */
export const ONRE_INTENT_PROGRAM_ID = new PublicKey('inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9')

/** Singleton setter-PDA seed inside `intent_transfer`. */
export const INTENT_TRANSFER_SETTER_SEED = Buffer.from('intent_transfer')

/** Per-program signer-PDA seed required by the FOGO session token rail. */
export const PROGRAM_SIGNER_SEED = Buffer.from('fogo_session_program_signer')

export const USDC_DECIMALS = 6
export const ONYC_DECIMALS = 9
export const FOGO_ONYC_DECIMALS = ONYC_DECIMALS

/** Denominator used by `applyFeeBps`. Matches the relayer's `10_000`. */
export const FEE_DENOMINATOR_BPS = 10_000n

/** Max bps the relayer will accept per leg. Matches `MAX_FEE_BPS = 1000` (10%). */
export const MAX_FEE_BPS = 1_000

/**
 * Slot delay for fee *increases*. Mirrors on-chain
 * `FEE_TIMELOCK_SLOTS = 432_000` (~2 days @ 400ms slots). Lets authority
 * tooling compute when a staged increase becomes promotable.
 */
export const FEE_TIMELOCK_SLOTS = 432_000n

/** Seconds in a 365-day year. Matches the architecture-doc price formula. */
export const SECONDS_PER_YEAR = 31_536_000n
