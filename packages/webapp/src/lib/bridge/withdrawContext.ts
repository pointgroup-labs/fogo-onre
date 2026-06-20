'use client'

/**
 * Redeem-side `BridgeContextProvider` factory — the ONyc analogue of
 * `depositContext.ts`, building the `BridgeContext` for the FOGO → Solana
 * ONyc redeem path through `intent_transfer.bridge_ntt_tokens`.
 *
 * A hard mirror of deposit: same account shape and intent_transfer fork.
 * Only the leg-specific identifiers differ — bridged mint is ONyc, the fee
 * is paid in ONyc, and the quote routes through the ONyc NTT managers
 * (`fetchOnycRedeemQuote`). Shared helpers live in `./intentBridgeShared`.
 */

import type { BridgeContextProvider } from './context'
import { ONYC_DECIMALS, ONYC_MINT } from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import {
  FOGO_NETWORK,
  FOGO_ONYC_MINT,
  REDEEM_INTENT_PROGRAM_ID,
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

/**
 * Optional overrides. Most deployments pass `{}`. Mirrors
 * `DepositBridgeConfig` minus the fee-token mint/symbol — the redeem fee
 * is fixed to ONyc, so there is no fee-token choice to override.
 */
export interface WithdrawBridgeConfig {
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

export function createWithdrawBridgeContextProvider(
  overrides: WithdrawBridgeConfig = {},
): BridgeContextProvider {
  return async ({ walletPublicKey, recipientAddress, amount, outboxItem }) => {
    const bridgeSponsor = await fetchBridgeSponsor()
    // Redeem pays its fee in ONyc: fee_source is the user's ONyc ATA. The fee
    // receiver comes from the on-chain FeeConfig `fee_recipient` (an ATA OnRe
    // controls); `bridgeSponsor` stays the gas payer / `sponsor` account.
    const pdas = deriveIntentPdas(walletPublicKey, REDEEM_INTENT_PROGRAM_ID, FOGO_ONYC_MINT, FOGO_ONYC_MINT)

    const resolvedFeeConfig = overrides.feeConfig ?? pdas.feeConfig
    const feeSource = overrides.feeSource
      ?? getAssociatedTokenAddressSync(FOGO_ONYC_MINT, walletPublicKey)

    const { fogoRpcUrl, solanaRpcUrl } = getSettings()
    const fogoConn = getFogoConnection(fogoRpcUrl)
    const destinationAta = getAssociatedTokenAddressSync(ONYC_MINT, recipientAddress, true)

    const [nonceValue, feeConfigData, payDestinationAtaRent, wormhole] = await Promise.all([
      readNonceCount(fogoConn, pdas.noncePda),
      readFeeConfig(fogoConn, resolvedFeeConfig),
      destinationAtaIsMissing(destinationAta, solanaRpcUrl),
      import('./wormholeNttQuote').then(m => m.fetchOnycRedeemQuote({
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
      ?? getAssociatedTokenAddressSync(FOGO_ONYC_MINT, feeConfigData.feeRecipient ?? bridgeSponsor, true)

    const feeAmount = overrides.feeAmount
      ?? formatBaseUnitsExact(feeConfigData.bridgeTransferFee, ONYC_DECIMALS)

    return {
      signedQuoteBytes: wormhole.signedQuoteBytes,
      addressLookupTable: wormhole.addressLookupTable,
      payDestinationAtaRent,
      intent: {
        fromChainId: FOGO_CHAIN_ID_BY_NETWORK[FOGO_NETWORK],
        toChainId: TO_CHAIN_ID_SOLANA,
        tokenSymbolOrMint: 'ONyc',
        amount: formatBaseUnitsExact(amount, ONYC_DECIMALS),
        feeTokenSymbolOrMint: 'ONyc',
        feeAmount,
        nonce: nonceValue + 1n,
      },
      topLevel: {
        intentTransferProgramId: REDEEM_INTENT_PROGRAM_ID,
        fromChainId: overrides.fromChainIdAccount ?? pdas.fromChainIdAccount,
        intentTransferSetter: pdas.intentTransferSetter,
        source: pdas.sourceAta,
        intermediateTokenAccount: overrides.intermediateTokenAccount ?? pdas.intermediateTokenAccount,
        mint: FOGO_ONYC_MINT,
        metadata: overrides.metadata ?? findMetaplexMetadataPda(FOGO_ONYC_MINT),
        expectedNttConfig: overrides.expectedNttConfig ?? pdas.expectedNttConfig,
        nonce: pdas.noncePda,
        sponsor: bridgeSponsor,
        feeSource,
        feeDestination,
        feeMint: FOGO_ONYC_MINT,
        feeMetadata: overrides.feeMetadata ?? findMetaplexMetadataPda(FOGO_ONYC_MINT),
        feeConfig: resolvedFeeConfig,
      },
      ntt: wormhole.ntt,
    }
  }
}
