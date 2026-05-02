import { PublicKey } from '@solana/web3.js'

export const APP_NAME = 'Fogo OnRe'
export const APP_DOMAIN = 'fogo-onre.example'

export const FOGO_RPC_URL
  = process.env.NEXT_PUBLIC_FOGO_RPC_URL ?? 'https://testnet.fogo.io'

export const SOLANA_RPC_URL
  = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'

// Wormhole-bridged USDC on FOGO. The user holds this and deposits with it.
// TODO: replace placeholder with the canonical USDC.s mint when published.
export const USDC_S_MINT = new PublicKey('11111111111111111111111111111111')

// NTT-bridged ONyc on FOGO. The user receives this on deposit, burns it on withdraw.
// TODO: replace placeholder with the bONyc mint produced by the NTT setup
// (see docs/deploy-mainnet.md §7.1).
export const BONYC_MINT = new PublicKey('11111111111111111111111111111111')

export const USDC_S_DECIMALS = 6
export const BONYC_DECIMALS = 6

// What FOGO Gateway sends USDC.s to (the relayer's redeemer authority on Solana,
// derived from the relayer program ID). Encoded as the Gateway transfer recipient.
// TODO: derive via SDK helper once @fogo-onre/sdk exposes the FOGO-side payload builder.
