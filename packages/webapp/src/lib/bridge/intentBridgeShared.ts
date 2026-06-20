'use client'

/**
 * Leg-agnostic pieces shared by the deposit (USDC.s) and redeem (ONyc)
 * `BridgeContextProvider` factories. Both legs route through
 * `intent_transfer.bridge_ntt_tokens` with the same account shape; only
 * the mint, fee token, NTT manager, and target program differ. Everything
 * that is a pure function of those inputs (or of the wallet) lives here.
 */

import { INTENT_TRANSFER_SETTER_SEED } from '@fogo-onre/sdk'
import { Network } from '@fogo/sessions-sdk-react'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { FOGO_BRIDGE_PAYMASTER_DOMAIN, FOGO_NETWORK } from '@/constants'
import { getFogoConnection, getSolanaConnection } from '@/utils/connections'
import { findFeeConfigPda } from './feeConfig'

// Metaplex Token Metadata program. Derives the per-mint metadata PDA that
// intent_transfer's `verify_symbol_or_mint` checks when an intent
// references a token by symbol (see verify.rs::verify_symbol_or_mint).
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const METAPLEX_METADATA_SEED = Buffer.from('metadata')
export function findMetaplexMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [METAPLEX_METADATA_SEED, METAPLEX_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_METADATA_PROGRAM_ID,
  )
  return pda
}

// Chain-id strings the on-chain `chain_id` registry stores. Confirmed
// against the FOGO mainnet PDA: literal `fogo-mainnet` (NOT bare `fogo`);
// intent_transfer enforces strict equality (drift → ChainIdMismatch).
// `to_chain_id` is Wormhole's canonical destination name (`solana`).
export const FOGO_CHAIN_ID_BY_NETWORK: Record<Network, string> = {
  [Network.Mainnet]: 'fogo-mainnet',
  [Network.Testnet]: 'fogo-testnet',
}
export const TO_CHAIN_ID_SOLANA = 'solana'

// intent_transfer PDA seeds (verified against
// @fogo/sessions-idls/idl/intent-transfer.json bridge_ntt_tokens accounts).
const IT_SEED_NONCE = Buffer.from('bridge_ntt_nonce')
const IT_SEED_INTERMEDIATE = Buffer.from('bridge_ntt_intermediate')
const IT_SEED_EXPECTED_NTT_CONFIG = Buffer.from('expected_ntt_config')

// Chain-ID registry program (separate from intent_transfer). Houses the
// singleton `["chain_id"]` PDA recording the FOGO source chain identifier.
const CHAIN_ID_PROGRAM_ID = new PublicKey('Cha1RcWkdcF1dmGuTui53JmSnVCacCc2Kx2SY7zSFhaN')
const CHAIN_ID_SEED = Buffer.from('chain_id')

// Default Fogo paymaster URL by network. Mirrors `DEFAULT_PAYMASTER` in
// @fogo/sessions-sdk (not exported, kept in sync by hand). Override via
// NEXT_PUBLIC_FOGO_PAYMASTER_URL.
const DEFAULT_PAYMASTER_URL_BY_NETWORK: Record<Network, string> = {
  [Network.Mainnet]: 'https://fogo-mainnet.dourolabs-paymaster.xyz',
  [Network.Testnet]: 'https://fogo-testnet.dourolabs-paymaster.xyz',
}
function paymasterUrl(): string {
  return process.env.NEXT_PUBLIC_FOGO_PAYMASTER_URL
    ?? DEFAULT_PAYMASTER_URL_BY_NETWORK[FOGO_NETWORK]
}

// Cache the resolved bridge sponsor pubkey for the process lifetime.
// It rotates rarely (autoassigned per domain by the paymaster).
const bridgeSponsorCache = new Map<string, PublicKey>()
export async function fetchBridgeSponsor(): Promise<PublicKey> {
  const domain = FOGO_BRIDGE_PAYMASTER_DOMAIN
  const cached = bridgeSponsorCache.get(domain)
  if (cached) {
    return cached
  }
  const url = new URL('/api/sponsor_pubkey', paymasterUrl())
  url.searchParams.set('domain', domain)
  url.searchParams.set('index', 'autoassign')
  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(
      `Failed to resolve bridge sponsor pubkey (HTTP ${response.status}): ${await response.text()}`,
    )
  }
  const sponsor = new PublicKey((await response.text()).trim())
  bridgeSponsorCache.set(domain, sponsor)
  return sponsor
}

export interface IntentBridgePdas {
  sourceAta: PublicKey
  intentTransferSetter: PublicKey
  noncePda: PublicKey
  intermediateTokenAccount: PublicKey
  expectedNttConfig: PublicKey
  feeConfig: PublicKey
  fromChainIdAccount: PublicKey
}

/**
 * Derives every PDA + ATA `bridge_ntt_tokens` needs that is a pure
 * function of (wallet, program, bridged mint, fee mint). Network-dependent
 * values (nonce counter, fee amount, dest-ATA existence) fetch live.
 */
export function deriveIntentPdas(
  walletPublicKey: PublicKey,
  intentProgramId: PublicKey,
  bridgeMint: PublicKey,
  feeMint: PublicKey,
): IntentBridgePdas {
  const sourceAta = getAssociatedTokenAddressSync(bridgeMint, walletPublicKey)
  const [intentTransferSetter] = PublicKey.findProgramAddressSync(
    [INTENT_TRANSFER_SETTER_SEED],
    intentProgramId,
  )
  const [noncePda] = PublicKey.findProgramAddressSync(
    [IT_SEED_NONCE, walletPublicKey.toBuffer()],
    intentProgramId,
  )
  const [intermediateTokenAccount] = PublicKey.findProgramAddressSync(
    [IT_SEED_INTERMEDIATE, sourceAta.toBuffer()],
    intentProgramId,
  )
  const [expectedNttConfig] = PublicKey.findProgramAddressSync(
    [IT_SEED_EXPECTED_NTT_CONFIG, bridgeMint.toBuffer()],
    intentProgramId,
  )
  const feeConfig = findFeeConfigPda(feeMint)
  const [fromChainIdAccount] = PublicKey.findProgramAddressSync(
    [CHAIN_ID_SEED],
    CHAIN_ID_PROGRAM_ID,
  )
  return {
    sourceAta,
    intentTransferSetter,
    noncePda,
    intermediateTokenAccount,
    expectedNttConfig,
    feeConfig,
    fromChainIdAccount,
  }
}

/**
 * Read the on-chain `bridge_ntt_nonce` count. Layout: 8-byte disc then
 * `count: u64 LE`. Returns 0n if the PDA doesn't exist yet
 * (`init_if_needed` creates it at 0; the handler increments to 1).
 */
export async function readNonceCount(
  conn: ReturnType<typeof getFogoConnection>,
  noncePda: PublicKey,
): Promise<bigint> {
  const acct = await conn.getAccountInfo(noncePda, 'confirmed')
  if (acct === null || acct.data.length < 8 + 8) {
    return 0n
  }
  return acct.data.readBigUInt64LE(8)
}

export async function destinationAtaIsMissing(ata: PublicKey, solanaRpcUrl: string): Promise<boolean> {
  const conn = getSolanaConnection(solanaRpcUrl)
  const acct = await conn.getAccountInfo(ata, 'confirmed')
  return acct === null
}
