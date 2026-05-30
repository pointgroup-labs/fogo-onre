import { FOGO_ONYC_DECIMALS, ONRE_INTENT_PROGRAM_ID, USDC_DECIMALS } from '@fogo-onre/sdk'
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
//
// `NEXT_PUBLIC_*` vars are inlined at build time, so any missing value
// here ships into the client bundle. We surface a build-time warning
// instead of throwing because:
//   1. The fallback (`https://app.ignitionfi.xyz`) IS a real
//      registered paymaster domain — falling back to it is safe, not
//      catastrophic.
//   2. Throwing here breaks `next build` during static prerender (the
//      module is evaluated by the build worker, not just at request
//      time), which blocks every CI build that hasn't pre-set the env
//      var even when the fallback would have been correct.
// Operators wanting a different domain still get a loud warning in
// build logs, and a misconfigured deploy fails fast at first request
// when the paymaster rejects the unregistered domain.
const DEFAULT_APP_DOMAIN = 'https://app.ignitionfi.xyz'
function resolveAppDomain(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_DOMAIN
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv
  }
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      `[fogo-onre] NEXT_PUBLIC_APP_DOMAIN not set; falling back to ${DEFAULT_APP_DOMAIN}. `
      + `Set it in your environment if you mean to register a different paymaster domain.`,
    )
  }
  return DEFAULT_APP_DOMAIN
}
export const APP_DOMAIN = resolveAppDomain()

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
export const FOGO_ONYC_MINT = new PublicKey('oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa')

// Per-call paymaster routing for the deposit bridge tx. We use OUR
// APP_DOMAIN lane (sponsor autoassigned by the Fogo paymaster for our
// domain) under the `OnReBridge` variation, NOT Fogo Labs' generic
// `sessions` lane. Our sponsor pays the FOGO landing gas and, because
// the bridge fee lands in the sponsor's ATA, the deposit fee accrues
// to us. Wired through `sendTransaction`'s sendTxOptions in the
// deposit hooks; the sponsor pubkey is resolved per-call from
// `/api/sponsor_pubkey?domain=<APP_DOMAIN>` in depositContext.ts.
export const FOGO_BRIDGE_PAYMASTER_DOMAIN = APP_DOMAIN
export const FOGO_BRIDGE_VARIATION = 'OnReBridge'

// Program the deposit `bridge_ntt_tokens` ix targets. The OnRe fork of
// Fogo's audited intent_transfer (source-identical, declare_id! only);
// the relayer pins its setter PDA. Swap back to `INTENT_TRANSFER_PROGRAM_ID`
// to revert deposits to Fogo's program.
export const DEPOSIT_INTENT_PROGRAM_ID = ONRE_INTENT_PROGRAM_ID

// FOGO-side NTT manager program IDs. Burning-mode managers, one per
// bridged mint. The user-signed `transfer_burn` instruction is dispatched
// to these.
//
// USDC.s: published in
// https://configs.labsapis.com/mainnet/tokens.ntt.json (`USDC.s` entry,
// chain=Fogo). Identical address to the Solana-side USDC NTT manager —
// same program deployed at the same key on both chains.
export const FOGO_USDC_S_NTT_MANAGER_ID = new PublicKey('nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk')
// ONyc: same program ID deployed on both Solana (locking) and FOGO (burning).
export const FOGO_ONYC_NTT_MANAGER_ID = new PublicKey('nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd')

// FOGO Wormhole Core program ID (mainnet). Mirrors the cli's
// `FOGO_WORMHOLE_CORE_MAINNET` constant — pinned here so the webapp can
// build `release_wormhole_outbound` against it without pulling in the
// cli/cranker. Source: `@wormhole-foundation/sdk-base` core contracts
// table (chain="Fogo", network="Mainnet").
export const FOGO_WORMHOLE_CORE_PROGRAM_ID = new PublicKey('worm2mrQkG1B1KTz37erMfWN8anHkSK24nzca7UD8BB')

// Custom LUT deployed via `scripts/deploy-fogo-deposit-lut.mjs`. Strict
// superset of the Sessions-SDK bridging LUT (`7hmMz3…`) plus the 7
// globals (ComputeBudget, Ed25519, Xfry4dW…, So11…112, and 3
// NTT/intent_transfer PDAs) that the bridging LUT doesn't cover when
// fee_token = wFOGO. Without this LUT, the deposit tx serializes to
// 1339 bytes and the paymaster rejects it (>1232 limit). Authority is
// `tiaModT…GzKLA`, kept mutable so the LUT can track upstream
// bridging-LUT extensions until Sessions ships broader coverage.
//
// Override via `NEXT_PUBLIC_FOGO_DEPOSIT_LUT` if a network swap or
// re-deploy is needed without changing source.
const FOGO_DEPOSIT_LUT_DEFAULT_BY_NETWORK: Partial<Record<Network, string>> = {
  [Network.Mainnet]: 'DDu9vk67v32ZzvUmD3knTByz3mFmdGyzD81h6vg9mUmD',
}
export const FOGO_DEPOSIT_LUT_OVERRIDE: string | null
  = process.env.NEXT_PUBLIC_FOGO_DEPOSIT_LUT
    ?? FOGO_DEPOSIT_LUT_DEFAULT_BY_NETWORK[FOGO_NETWORK]
    ?? null

// Token decimals are protocol invariants and live in the SDK.
export { FOGO_ONYC_DECIMALS, USDC_DECIMALS }

// True iff the ONyc mint and FOGO-side ONyc NTT manager have both been
// replaced with their real deployment addresses AND the
// `NEXT_PUBLIC_WITHDRAW_ENABLED` env gate is not explicitly disabled.
// Until both conditions hold, the withdraw flow surfaces an explicit
// "deployment pending" notice rather than silently failing.
//
// The env gate exists so devnet/preview environments (where the
// Solana-side relayer config is rebuildable but not yet trusted by
// users) can keep withdraw hidden from the UI without a code change.
// Default is enabled — set `NEXT_PUBLIC_WITHDRAW_ENABLED=false` to hide.
const PLACEHOLDER_PUBKEY = '11111111111111111111111111111111'
const ADDRESSES_REAL
  = FOGO_ONYC_MINT.toBase58() !== PLACEHOLDER_PUBKEY
    && FOGO_ONYC_NTT_MANAGER_ID.toBase58() !== PLACEHOLDER_PUBKEY
const WITHDRAW_ENABLED_ENV = process.env.NEXT_PUBLIC_WITHDRAW_ENABLED
const WITHDRAW_ENABLED = WITHDRAW_ENABLED_ENV !== 'false'
export const FOGO_ONYC_DEPLOYMENT_READY = ADDRESSES_REAL && WITHDRAW_ENABLED
