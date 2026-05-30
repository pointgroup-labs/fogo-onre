import type { BuildBridgeOutIntentMessageParams, NttBridgeSubAccounts } from '@fogo-onre/sdk'
import type { PublicKey } from '@solana/web3.js'

/**
 * Wire pieces a bridge leg needs that can't be synthesized from the
 * session alone. Both legs (USDC.s deposit, ONyc redeem) route through
 * `intent_transfer.bridge_ntt_tokens` with the same shape — the only
 * differences (mint, NTT manager, fee token, token symbols) are carried
 * in the fields below, so the hook stays leg-agnostic.
 *
 * The signed Wormhole executor quote (165 bytes) and the NTT
 * sub-account constellation require live Wormhole NTT route + executor
 * relay calls, so they're resolved by a caller-supplied
 * `BridgeContextProvider` rather than derived in the hook.
 */
export interface BridgeContext {
  signedQuoteBytes: Uint8Array
  payDestinationAtaRent: boolean
  /**
   * Address-lookup table for `sendTransaction`. The NTT manager
   * publishes a LUT covering its account constellation (config, peer,
   * transceiver, custody, wormhole bridge accounts, etc.); without it
   * `bridge_ntt_tokens` blows past the 1232-byte legacy-tx limit.
   */
  addressLookupTable?: PublicKey
  intent: Omit<BuildBridgeOutIntentMessageParams, 'recipientAddress'>
  topLevel: {
    intentTransferProgramId: PublicKey
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
  }
  ntt: NttBridgeSubAccounts
}

export type BridgeContextProvider = (params: {
  walletPublicKey: PublicKey
  recipientAddress: PublicKey
  amount: bigint
  outboxItem: PublicKey
}) => Promise<BridgeContext>
