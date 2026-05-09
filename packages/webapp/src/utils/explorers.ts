'use client'

/**
 * Block-explorer URL builders.
 *
 * Centralized so every component renders the same link target for the
 * same identifier. FogoScan is used for FOGO-side tx signatures (the
 * webapp only signs FOGO txs); Wormholescan tracks the bridged VAA
 * derived from a FOGO emitter+sequence pair, but we don't have the
 * sequence at render time, so we link to a Wormholescan search by
 * source-tx-hash which the backend resolves to the VAA.
 *
 * Network selection is intentionally NOT plumbed through here — both
 * FogoScan and Wormholescan host devnet/testnet under separate
 * subdomains, but the webapp config currently pins mainnet by default
 * and routes testnet through env. If/when network-aware explorers
 * matter, hoist `FOGO_NETWORK` here and branch.
 */

const FOGOSCAN_BASE = 'https://fogoscan.com'
const WORMHOLESCAN_BASE = 'https://wormholescan.io'

export function fogoTxUrl(signature: string): string {
  return `${FOGOSCAN_BASE}/tx/${signature}`
}

/**
 * Wormholescan resolves a source-chain tx hash to the cross-chain VAA
 * via its search endpoint. The path `/#/tx/<sig>` is the public-facing
 * deep-link they document; works for both NTT and legacy Token Bridge
 * messages.
 */
export function wormholeTxUrl(signature: string): string {
  return `${WORMHOLESCAN_BASE}/#/tx/${signature}`
}

/** Short-form display string for a long signature, e.g. `abc12345…wxyz9876`. */
export function shortSig(signature: string): string {
  if (signature.length <= 18) {
    return signature
  }
  return `${signature.slice(0, 8)}…${signature.slice(-8)}`
}
