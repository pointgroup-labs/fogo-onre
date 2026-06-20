'use client'

/**
 * Deposit-side `BridgeContextProvider` factory: builds the `BridgeContext`
 * the transfer hook consumes for the FOGO → Solana USDC.s deposit path
 * through `intent_transfer.bridge_ntt_tokens`.
 *
 * This module owns the intent_transfer PDAs, chain-id registry PDA, fee
 * ATAs, source ATA, and the dest-ATA check driving `payDestinationAtaRent`.
 * `./wormholeNttQuote` owns the signed executor quote and every NTT
 * sub-account; it pulls in the heavy `@wormhole-foundation/sdk` bundle, so
 * we load it via dynamic import to keep it out of the initial page chunk.
 */

import type { BridgeContextProvider } from './context'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import {
  DEPOSIT_INTENT_PROGRAM_ID,
  FOGO_NETWORK,
  SOLANA_USDC_MINT,
  USDC_DECIMALS,
  USDC_S_MINT,
} from '@/constants'
import { getSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'
import { formatBaseUnitsExact } from '@/utils/transfer'
import { readFeeConfig } from './feeConfig'
import {
  deriveIntentPdas,
  destinationAtaIsMissing,
  fetchBridgeSponsor,
  findMetaplexMetadataPda,
  FOGO_CHAIN_ID_BY_NETWORK,
  readNonceCount,
  TO_CHAIN_ID_SOLANA,
} from './intentBridgeShared'

/** Optional overrides; every field defaults sensibly — most callers pass `{}`. */
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
    // `bridgeSponsor` plays two roles — `bridge_ntt_tokens.sponsor` and the
    // tx fee payer (gas). The fee *receiver* is now separate: it comes from
    // the on-chain FeeConfig `fee_recipient`, so collected fees land in an
    // ATA OnRe controls rather than the paymaster-custodied sponsor ATA.
    const bridgeSponsor = await fetchBridgeSponsor()
    // Fee token defaults to USDC.s; the symbol must byte-match the mint's
    // Metaplex metadata (`verify_symbol_or_mint`), which reads `USDC.s`.
    const { feeMint, feeSymbol } = resolveFeeIdentity(overrides)
    const pdas = deriveIntentPdas(walletPublicKey, DEPOSIT_INTENT_PROGRAM_ID, USDC_S_MINT, feeMint)

    const resolvedFeeConfig = overrides.feeConfig ?? pdas.feeConfig
    const feeSource = overrides.feeSource
      ?? getAssociatedTokenAddressSync(feeMint, walletPublicKey)

    // Resolve RPC URLs from settings so a user override in the drawer
    // propagates to FOGO reads, the dest-ATA check, and the Wormhole SDK's
    // Solana connection (else it silently dials the public mainnet RPC).
    const { fogoRpcUrl, solanaRpcUrl } = getSettings()
    const fogoConn = getFogoConnection(fogoRpcUrl)
    const destinationAta = getAssociatedTokenAddressSync(SOLANA_USDC_MINT, recipientAddress, true)

    // Run all network work in parallel: nonce, fee config (fee + recipient,
    // one fetch), dest-ATA check, and the heavy (dynamically imported)
    // Wormhole quote + PDAs.
    const [nonceValue, feeConfigData, payDestinationAtaRent, wormhole] = await Promise.all([
      readNonceCount(fogoConn, pdas.noncePda),
      readFeeConfig(fogoConn, resolvedFeeConfig),
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

    // Fee ATA is owned by the configured `fee_recipient`; fall back to the
    // legacy sponsor-owned ATA only while the FeeConfig PDA is un-migrated.
    const feeDestination = overrides.feeDestination
      ?? getAssociatedTokenAddressSync(feeMint, feeConfigData.feeRecipient ?? bridgeSponsor, true)

    // User-facing fee comes from the on-chain FeeConfig PDA; tests can pin
    // a fixed string via `overrides.feeAmount`.
    const feeAmount = overrides.feeAmount
      ?? formatBaseUnitsExact(feeConfigData.bridgeTransferFee, USDC_DECIMALS)

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
        // `verify_and_update_nonce` requires message nonce == stored + 1;
        // `readNonceCount` returns the raw stored value (else NonceFailure).
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
 * Defaults the fee mint to USDC.s. The symbol must byte-match the mint's
 * on-chain Metaplex metadata (intent_transfer's `verify_symbol_or_mint`
 * compares against the `symbol` field, which for USDC.s reads `USDC.s`).
 */
function resolveFeeIdentity(overrides: DepositBridgeConfig): { feeMint: PublicKey, feeSymbol: string } {
  const feeMint = overrides.feeTokenMint ?? USDC_S_MINT
  const feeSymbol = overrides.feeTokenSymbol
    ?? (feeMint.equals(USDC_S_MINT) ? 'USDC.s' : feeMint.toBase58())
  return { feeMint, feeSymbol }
}
