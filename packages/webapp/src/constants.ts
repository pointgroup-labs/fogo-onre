import { BONYC_DECIMALS, USDC_DECIMALS } from '@fogo-onre/sdk'
import { Network } from '@fogo/sessions-sdk-react'
import { PublicKey } from '@solana/web3.js'

export const APP_NAME = 'Fogo OnRe'

// Domain the FogoSessionProvider hands to the paymaster. Must be a
// domain pre-registered with the Fogo paymaster service — otherwise
// `/api/sponsor_pubkey` returns 400 at session-establish time. The
// string is a lookup key, not the page's hostname, so a registered
// production domain (e.g. https://app.fogo-onre.example) works for
// local dev too. Set NEXT_PUBLIC_APP_DOMAIN per environment; see
// .env.example for the full story.
export const APP_DOMAIN
  // = process.env.NEXT_PUBLIC_APP_DOMAIN ?? 'https://app.fogo-onre.example'
  = process.env.NEXT_PUBLIC_APP_DOMAIN ?? 'https://app.ignitionfi.xyz'

// FOGO chain selection. Default mainnet — switch to testnet via env.
// NB: RPC URLs themselves live in `store/settings.ts` (with a default
// resolution chain of user override → env → hardcoded). We only export
// the network enum here because it's consumed by FogoSessionProvider.
const NETWORK_NAME = process.env.NEXT_PUBLIC_FOGO_NETWORK ?? 'mainnet'
export const FOGO_NETWORK
  = NETWORK_NAME === 'testnet' ? Network.Testnet : Network.Mainnet

// USDC.s on FOGO — the NTT-bridged USDC (manager `nttu74…`, transceiver
// `9ioH2…`), peered to canonical USDC `EPjFWdd5…` on Solana. Source:
// https://configs.labsapis.com/mainnet/tokens.ntt.json (`USDC.s` entry).
export const USDC_S_MINT = new PublicKey('uSd2czE61Evaf76RNbq4KPpXnkiL3irdzgLFUMe3NoG')

// Canonical USDC on Solana mainnet — the Solana-side counterpart of USDC.s.
// Used to derive the OnRe Offer PDA `(usdcMint, onycMint)` for live price
// reads. The relayer doesn't pin this on-chain (RelayerConfig only tracks
// `onyc_mint`), but the OnRe deployment quoting against it is mainnet-USDC
// by convention.
export const SOLANA_USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

// NTT-bridged ONyc on FOGO. The user receives this on deposit, burns it on withdraw.
// TODO: replace placeholder with the bONyc mint produced by the NTT setup
// (see docs/deploy-mainnet.md §7.1).
export const BONYC_MINT = new PublicKey('11111111111111111111111111111111')

// FOGO-side NTT manager program IDs. Burning-mode managers, one per
// bridged mint. The user-signed `transfer_burn` instruction is dispatched
// to these.
//
// USDC.s: published in
// https://configs.labsapis.com/mainnet/tokens.ntt.json (`USDC.s` entry,
// chain=Fogo). Identical address to the Solana-side USDC NTT manager —
// same program deployed at the same key on both chains.
export const FOGO_USDC_S_NTT_MANAGER_ID = new PublicKey('nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk')
// bONyc: TODO once Wormhole publishes the FOGO ↔ Solana ONyc deployment
// (see docs/deploy-mainnet.md §7.1).
export const FOGO_BONYC_NTT_MANAGER_ID = new PublicKey('11111111111111111111111111111111')

// Token decimals are protocol invariants and live in the SDK.
export { BONYC_DECIMALS, USDC_DECIMALS }

// True iff the bONyc mint and FOGO-side bONyc NTT manager have both been
// replaced with their real deployment addresses. Until this flips, the
// withdraw flow is structurally non-functional (a `transfer_burn` against
// the system program would fail at submission), so the UI surfaces an
// explicit "deployment pending" notice rather than silently failing.
const PLACEHOLDER_PUBKEY = '11111111111111111111111111111111'
export const BONYC_DEPLOYMENT_READY
  = BONYC_MINT.toBase58() !== PLACEHOLDER_PUBKEY
    && FOGO_BONYC_NTT_MANAGER_ID.toBase58() !== PLACEHOLDER_PUBKEY
