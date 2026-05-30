'use client'

/**
 * Deposit-side `BridgeContextProvider` factory.
 *
 * Builds the `BridgeContext` shape that the transfer hook consumes for
 * the FOGO → Solana USDC.s deposit path through
 * `intent_transfer.bridge_ntt_tokens`.
 *
 * Split of responsibilities:
 *   - **This module** owns IDL-derived intent_transfer PDAs (nonce,
 *     intermediate, expected_ntt_config, fee_config), the chain-id
 *     registry PDA, fee-source/destination ATAs, source ATA, and the
 *     destination-ATA-existence check that drives `payDestinationAtaRent`.
 *   - **`./wormholeNttQuote`** owns everything Wormhole: the signed
 *     executor quote, the per-quote payee, and every NTT sub-account
 *     (config, peer, rate limits, custody, transceiver, emitter,
 *     wormhole bridge/sequence/fee-collector, session authority bound
 *     to the per-user inbox PDA, etc.). That module pulls in the heavy
 *     `@wormhole-foundation/sdk` bundle, so we load it via dynamic
 *     import to keep it out of the initial page chunk.
 *
 * No `wormholeExecutorUrl` config is needed — `@wormhole-foundation/sdk-route-ntt`
 * has the executor URL baked in (`https://executor.labsapis.com`).
 */

import type { BridgeContextProvider } from './context'
import {
  findUserInboxAuthorityPda,
  INTENT_TRANSFER_SETTER_SEED,
  RELAYER_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { Network } from '@fogo/sessions-sdk-react'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import {
  DEPOSIT_INTENT_PROGRAM_ID,
  FOGO_BRIDGE_PAYMASTER_DOMAIN,
  FOGO_NETWORK,
  SOLANA_USDC_MINT,
  USDC_DECIMALS,
  USDC_S_MINT,
} from '@/constants'
import { getSettings } from '@/store/settings'
import { getFogoConnection, getSolanaConnection } from '@/utils/connections'
import { formatBaseUnitsExact } from '@/utils/transfer'
import { findFeeConfigPda, readBridgeTransferFee } from './feeConfig'

// Metaplex Token Metadata program. Used to derive the per-mint metadata
// PDA that intent_transfer's `verify_symbol_or_mint` checks against
// when the intent message references a token by symbol (rather than by
// mint pubkey). See:
//   programs/intent-transfer/src/verify.rs::verify_symbol_or_mint
//   - (Symbol, Some(metadata)) -> Anchor checks
//       metadata.key() == Metadata::find_pda(mint).0  (else MetadataMismatch=6011)
//       metadata.symbol == "<symbol>\0\0..."          (else SymbolMismatch=6012)
//   - (Symbol, None)            -> MetadataAccountRequired=6009
// Sessions-sdk always passes the real PDA when its intent uses a symbol
// (`@fogo/sessions-sdk` esm/index.js:745-748); we mirror that here for
// both the bridged token (`metadata`) and the fee token (`fee_metadata`).
const METAPLEX_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const METAPLEX_METADATA_SEED = Buffer.from('metadata')
function findMetaplexMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [METAPLEX_METADATA_SEED, METAPLEX_METADATA_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_METADATA_PROGRAM_ID,
  )
  return pda
}

// Canonical chain-id strings the on-chain `chain_id` registry stores.
// Confirmed by reading the FOGO mainnet `["chain_id"]` PDA under
// Cha1RcWkdcF1dmGuTui53JmSnVCacCc2Kx2SY7zSFhaN: it holds the literal
// string `fogo-mainnet` (NOT bare `fogo`). intent_transfer's
// `bridge_ntt_tokens` enforces strict equality between the intent
// message's `from_chain_id` field and the on-chain registry value;
// any drift here returns IntentTransferError::ChainIdMismatch (6005).
//
// `to_chain_id` is the destination chain's NTT name and is consumed
// downstream as a Wormhole chain identifier — for Solana the Wormhole
// canonical name is the bare `solana` (matching sessions-sdk's
// hardcoded value at `bridgeOut`).
const FOGO_CHAIN_ID_BY_NETWORK: Record<Network, string> = {
  [Network.Mainnet]: 'fogo-mainnet',
  [Network.Testnet]: 'fogo-testnet',
}
const TO_CHAIN_ID_SOLANA = 'solana'

// intent_transfer PDA seeds (verified against
// @fogo/sessions-idls/idl/intent-transfer.json bridge_ntt_tokens accounts).
const IT_SEED_NONCE = Buffer.from('bridge_ntt_nonce')
const IT_SEED_INTERMEDIATE = Buffer.from('bridge_ntt_intermediate')
const IT_SEED_EXPECTED_NTT_CONFIG = Buffer.from('expected_ntt_config')

// Chain-ID registry program (separate from intent_transfer). Address
// extracted from intent-transfer.json (`from_chain_id` PDA `program`
// field). Houses the singleton `["chain_id"]` PDA recording the FOGO
// source chain identifier.
const CHAIN_ID_PROGRAM_ID = new PublicKey('Cha1RcWkdcF1dmGuTui53JmSnVCacCc2Kx2SY7zSFhaN')
const CHAIN_ID_SEED = Buffer.from('chain_id')

// Default Fogo paymaster URL by network. Mirrors `DEFAULT_PAYMASTER` in
// @fogo/sessions-sdk's connection.js — kept in sync by hand because the
// SDK doesn't export it. Used by the `sessions`-domain sponsor lookup
// below; override per-env via NEXT_PUBLIC_FOGO_PAYMASTER_URL if a
// non-default paymaster is in play.
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
async function fetchBridgeSponsor(): Promise<PublicKey> {
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

/**
 * Optional overrides. Every field has a sensible default — most
 * deployments will pass `{}`. The fee mint defaults to USDC.s (matching
 * `@fogo/sessions-sdk`'s `getBridgeOutFee`); pass overrides only for
 * non-default fee tokens or for tests against a stub executor.
 */
export interface DepositBridgeConfig {
  feeTokenMint?: PublicKey
  feeTokenSymbol?: string
  feeAmount?: string
  feeConfig?: PublicKey
  feeSource?: PublicKey
  feeDestination?: PublicKey
  feeMetadata?: PublicKey | null
  metadata?: PublicKey | null
  intermediateTokenAccount?: PublicKey
  fromChainIdAccount?: PublicKey
  expectedNttConfig?: PublicKey
}

export function createDepositBridgeContextProvider(
  overrides: DepositBridgeConfig = {},
): BridgeContextProvider {
  return async ({ walletPublicKey, recipientAddress, amount, outboxItem }) => {
    // Our bridge sponsor (autoassigned for APP_DOMAIN). Same pubkey in
    // three roles — `bridge_ntt_tokens.sponsor`, `feeDestination` ATA
    // owner, and tx fee payer (the per-call paymasterDomain override) —
    // so the paymaster-rebuilt tx stays under the 1232 B legacy limit.
    const bridgeSponsor = await fetchBridgeSponsor()
    // Default fee token is USDC.s: intent_transfer converts the
    // executor's signed baseFee to USDC.s via the registered FeeConfig,
    // so the user's USDC.s pays both the bridged amount and the delivery
    // escrow. The fee symbol must byte-match the mint's Metaplex
    // metadata (`verify_symbol_or_mint`); for USDC.s that reads `USDC.s`.
    const { feeMint, feeSymbol } = resolveFeeIdentity(overrides)
    const pdas = derivePdas(walletPublicKey, feeMint)

    const resolvedFeeConfig = overrides.feeConfig ?? pdas.feeConfig
    const feeSource = overrides.feeSource
      ?? getAssociatedTokenAddressSync(feeMint, walletPublicKey)
    const feeDestination = overrides.feeDestination
      ?? getAssociatedTokenAddressSync(feeMint, bridgeSponsor, true)

    // Sanity-check the recipient handed in by the hook against the SDK's
    // PDA derivation. A mismatch here means hook/SDK version skew and
    // would otherwise silently route a deposit to the wrong inbox.
    const [perUserInbox] = findUserInboxAuthorityPda(walletPublicKey, RELAYER_PROGRAM_ID)
    if (!perUserInbox.equals(recipientAddress)) {
      throw new Error(
        'Internal: recipientAddress mismatch — hook handed a PDA that is not the per-user inbox. '
        + 'This indicates a hook/SDK version skew.',
      )
    }

    // Pull resolved RPC URLs from the settings store so the user-chosen
    // override in the settings drawer propagates to: (a) FOGO nonce/fee
    // reads, (b) the Solana dest-ATA check, and most importantly (c) the
    // Wormhole SDK's Solana connection inside `wormholeNttQuote`. Without
    // this, the Wormhole bundle silently dialled the public mainnet RPC
    // (CORS-blocked / cert-untrusted in many browsers).
    const { fogoRpcUrl, solanaRpcUrl } = getSettings()
    const fogoConn = getFogoConnection(fogoRpcUrl)
    const destinationAta = getAssociatedTokenAddressSync(SOLANA_USDC_MINT, perUserInbox, true)

    // Kick off everything that touches the network in parallel: nonce
    // read, fee read, dest-ATA existence check, and the (heavy) Wormhole
    // quote+PDA derivation. The Wormhole SDK module is dynamically
    // imported so the bundle stays out of the initial page load.
    const [nonceValue, bridgeFeeRaw, payDestinationAtaRent, wormhole] = await Promise.all([
      readNonceCount(fogoConn, pdas.noncePda),
      readBridgeTransferFee(fogoConn, resolvedFeeConfig),
      destinationAtaIsMissing(destinationAta, solanaRpcUrl),
      import('./wormholeNttQuote').then(m => m.fetchUsdcSDepositQuote({
        walletPublicKey,
        recipientOnSolana: recipientAddress,
        amount,
        outboxItem,
        solanaRpcUrl,
        intentTransferSetter: pdas.intentTransferSetter,
      })),
    ])

    // Render the fee from the on-chain FeeConfig PDA. For USDC.s the
    // configured `bridge_transfer_fee` is the canonical user-facing
    // figure; intent_transfer itself collects whatever delta the
    // executor quote demands when it forwards the transfer. Caller
    // can pin a fixed string via `overrides.feeAmount` (used by
    // tests against a stub executor).
    const feeAmount = overrides.feeAmount
      ?? formatBaseUnitsExact(bridgeFeeRaw, USDC_DECIMALS)

    return {
      signedQuoteBytes: wormhole.signedQuoteBytes,
      addressLookupTable: wormhole.addressLookupTable,
      payDestinationAtaRent,
      intent: {
        fromChainId: FOGO_CHAIN_ID_BY_NETWORK[FOGO_NETWORK],
        toChainId: TO_CHAIN_ID_SOLANA,
        tokenSymbolOrMint: 'USDC.s',
        amount: formatBaseUnitsExact(amount, USDC_DECIMALS),
        feeTokenSymbolOrMint: feeSymbol,
        feeAmount,
        // intent_transfer's `verify_and_update_nonce` requires the
        // message nonce to equal `stored_nonce + 1` (see
        // programs/intent-transfer/src/verify.rs::verify_and_update_nonce).
        // `readNonceCount` returns the raw stored value, so add one
        // here. Failing to do so returns NonceFailure (custom 6013).
        nonce: nonceValue + 1n,
      },
      topLevel: {
        intentTransferProgramId: DEPOSIT_INTENT_PROGRAM_ID,
        fromChainId: overrides.fromChainIdAccount ?? pdas.fromChainIdAccount,
        intentTransferSetter: pdas.intentTransferSetter,
        source: pdas.sourceAta,
        intermediateTokenAccount: overrides.intermediateTokenAccount ?? pdas.intermediateTokenAccount,
        mint: USDC_S_MINT,
        metadata: overrides.metadata ?? findMetaplexMetadataPda(USDC_S_MINT),
        expectedNttConfig: overrides.expectedNttConfig ?? pdas.expectedNttConfig,
        nonce: pdas.noncePda,
        sponsor: bridgeSponsor,
        feeSource,
        feeDestination,
        feeMint,
        feeMetadata: overrides.feeMetadata ?? findMetaplexMetadataPda(feeMint),
        feeConfig: resolvedFeeConfig,
      },
      ntt: wormhole.ntt,
    }
  }
}

/**
 * Defaults the fee mint to USDC.s. The executor's signed `baseFee` is
 * converted to USDC.s by intent_transfer itself when fee_mint is a
 * stablecoin with a registered FeeConfig — the user's USDC.s input pays
 * both the bridged amount and the cross-chain delivery escrow in a
 * single token, no FOGO native gas top-up required.
 *
 * The symbol must match the on-chain Metaplex metadata for the fee mint
 * exactly (intent_transfer's `verify_symbol_or_mint` does a byte-for-byte
 * compare against the metadata `symbol` field, which for USDC.s reads
 * as `USDC.s`).
 */
function resolveFeeIdentity(overrides: DepositBridgeConfig): { feeMint: PublicKey, feeSymbol: string } {
  const feeMint = overrides.feeTokenMint ?? USDC_S_MINT
  const feeSymbol = overrides.feeTokenSymbol
    ?? (feeMint.equals(USDC_S_MINT) ? 'USDC.s' : feeMint.toBase58())
  return { feeMint, feeSymbol }
}

/**
 * Derives every PDA + ATA the deposit ix needs that's a pure function
 * of (walletPublicKey, feeMint). Network-dependent values (nonce
 * counter, fee amount, dest-ATA existence) are not derived here — they
 * fetch live in the parallel `Promise.all` above.
 */
function derivePdas(walletPublicKey: PublicKey, feeMint: PublicKey): {
  sourceAta: PublicKey
  intentTransferSetter: PublicKey
  noncePda: PublicKey
  intermediateTokenAccount: PublicKey
  expectedNttConfig: PublicKey
  feeConfig: PublicKey
  fromChainIdAccount: PublicKey
} {
  const sourceAta = getAssociatedTokenAddressSync(USDC_S_MINT, walletPublicKey)
  const [intentTransferSetter] = PublicKey.findProgramAddressSync(
    [INTENT_TRANSFER_SETTER_SEED],
    DEPOSIT_INTENT_PROGRAM_ID,
  )
  const [noncePda] = PublicKey.findProgramAddressSync(
    [IT_SEED_NONCE, walletPublicKey.toBuffer()],
    DEPOSIT_INTENT_PROGRAM_ID,
  )
  const [intermediateTokenAccount] = PublicKey.findProgramAddressSync(
    [IT_SEED_INTERMEDIATE, sourceAta.toBuffer()],
    DEPOSIT_INTENT_PROGRAM_ID,
  )
  const [expectedNttConfig] = PublicKey.findProgramAddressSync(
    [IT_SEED_EXPECTED_NTT_CONFIG, USDC_S_MINT.toBuffer()],
    DEPOSIT_INTENT_PROGRAM_ID,
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
 * Read the on-chain `bridge_ntt_nonce` count. Layout per the
 * intent_transfer IDL: 8-byte Anchor disc, then `count: u64 LE`. If the
 * PDA doesn't exist (first deposit from this wallet), intent_transfer's
 * `init_if_needed` constraint creates it at count=0; we return 0n here
 * and the on-chain handler increments to 1.
 */
async function readNonceCount(
  conn: ReturnType<typeof getFogoConnection>,
  noncePda: PublicKey,
): Promise<bigint> {
  const acct = await conn.getAccountInfo(noncePda, 'confirmed')
  if (acct === null || acct.data.length < 8 + 8) {
    return 0n
  }
  return acct.data.readBigUInt64LE(8)
}

async function destinationAtaIsMissing(ata: PublicKey, solanaRpcUrl: string): Promise<boolean> {
  const conn = getSolanaConnection(solanaRpcUrl)
  const acct = await conn.getAccountInfo(ata, 'confirmed')
  return acct === null
}
