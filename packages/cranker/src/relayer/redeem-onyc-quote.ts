/**
 * Recovery quoter — composes the on-chain NAV floor with a fresh Jupiter
 * quote so the cancel-branch log can answer "would `redeem_onyc` accept
 * this route right now?". Pure observation in this slice — no broadcast.
 *
 * Deploy-readiness notes:
 *  - `swap_delegate` (Jupiter's `programAuthority`) is *intentionally not*
 *    surfaced here. The SDK's `fetchJupiterRoute` does not expose it, and
 *    `scripts/recover-redeem-onyc.ts` refuses to run without an explicit
 *    `SWAP_DELEGATE` env var because guessing it wrong burns the on-chain
 *    ~2-day cooldown. Heuristic extraction from `routeAccounts` is unsafe
 *    by construction — operators must copy `programAuthority` from the
 *    Jupiter quote response at recovery time. The preview's job is just
 *    to flag whether a route *exists* that clears the NAV floor.
 *  - Every RPC + HTTP call is wrapped in `withTimeout` so a Jupiter
 *    outage or stuck `getAccountInfo` cannot freeze the cranker tick.
 *  - The caller (`claim-redemption-usdc.ts`) is responsible for per-flow
 *    rate-limiting — see the `quoteCache` Map there. The cancel
 *    fingerprint persists for the full ~2-day cooldown; an unrate-limited
 *    quoter would emit ~5,760 Jupiter calls per stuck flow.
 */
import type { AccountMeta, Connection, PublicKey } from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { fetchJupiterRoute, findOnreOfferPda } from '@fogo-onre/sdk'
import { withTimeout } from '../utils/rpc'
import {
  applySlippageFloor,
  calculateStepPrice,
  MAX_SLIPPAGE_BPS,
  parseActiveOfferVector,
  redemptionExpectedOut,
} from './onre-nav'

// SPL Mint layout: decimals byte at fixed offset 44.
// (Mirrors @solana/spl-token's Mint layout; replicated here to avoid
// pulling the full unpackMint dependency into a hot pre-flight path.)
const SPL_MINT_DECIMALS_OFFSET = 44
const SPL_MINT_MIN_LEN = 82

function readMintDecimals(data: Uint8Array | Buffer | null | undefined): number | null {
  if (!data || data.length < SPL_MINT_MIN_LEN) {
    return null
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return buf.readUInt8(SPL_MINT_DECIMALS_OFFSET)
}

export interface QuoteRedeemOnycRecoveryParams {
  connection: Connection
  usdcMint: PublicKey
  onycMint: PublicKey
  /**
   * Relayer authority PDA. Used as Jupiter's `userPublicKey` so the SDK
   * builds the route for the correct on-chain signer AND clears the
   * outer-tx signer bit on the right meta. Passing the wrong key (e.g.
   * a mint sentinel) silently produces a route that an auto-fire path
   * could not submit.
   */
  relayerAuthorityPda: PublicKey
  /** From `redemption_tracker.onyc_amount_in` (the delegated cap). */
  onycAmountIn: bigint
  /** Unix seconds — typically `Math.floor(Date.now()/1000)`; injectable for tests. */
  nowUnix: bigint
  /** Timeout for each `getAccountInfo` call and for the Jupiter quote round-trip. */
  rpcTimeoutMs: number
  /** Override for tests; defaults to global `fetch`. Threaded into the SDK. */
  fetchImpl?: typeof fetch
}

export type QuoteRedeemOnycRecoveryResult
  = | {
    decision: 'quoted'
    /** NAV-derived floor `redeem_onyc` will enforce on-chain. */
    navFloor: bigint
    /** Pre-haircut expected output at OnRe NAV. */
    grossExpected: bigint
    /** Jupiter's quoted USDC out for this onyc_amount_in. */
    quotedOut: bigint
    /** True iff `quotedOut >= navFloor`. */
    clearsFloor: boolean
    /** Lookup-table pubkeys Jupiter returned. Logged in full at the call site so an operator running the recovery script can pre-fetch them. */
    addressLookupTables: PublicKey[]
    /** Raw Jupiter `shared_accounts_route` data; carried so a future auto-fire path doesn't re-quote. */
    swapIxData: Uint8Array
    /** Account list ordered by Jupiter IDL; carried for the same reason. */
    swapAccounts: AccountMeta[]
  }
  | {
    decision: 'quote_failed'
    /** Floor still computed; only Jupiter side failed. Useful for ops triage. */
    navFloor: bigint
    grossExpected: bigint
    reason: string
  }
  | {
    decision: 'offer_unavailable'
    reason: string
  }

/**
 * Reads the OnRe deposit-side `Offer` PDA, mirrors the on-chain NAV floor
 * computation, fetches a fresh Jupiter `shared_accounts_route` quote, and
 * returns a structured comparison. Never throws — RPC and HTTP failures
 * downgrade to typed `decision` variants so the cranker tick stays alive.
 */
export async function quoteRedeemOnycRecovery(
  params: QuoteRedeemOnycRecoveryParams,
): Promise<QuoteRedeemOnycRecoveryResult> {
  const {
    connection,
    usdcMint,
    onycMint,
    relayerAuthorityPda,
    onycAmountIn,
    nowUnix,
    rpcTimeoutMs,
    fetchImpl,
  } = params

  // Compute the on-chain floor first. If this fails, Jupiter is irrelevant.
  let navFloor: bigint
  let grossExpected: bigint
  try {
    const [offerPda] = findOnreOfferPda(usdcMint, onycMint)
    const [offerInfo, usdcMintInfo, onycMintInfo] = await withTimeout(
      Promise.all([
        connection.getAccountInfo(offerPda),
        connection.getAccountInfo(usdcMint),
        connection.getAccountInfo(onycMint),
      ]),
      rpcTimeoutMs,
      'quoteRedeemOnycRecovery.getAccountInfo(offer+mints)',
    )
    if (!offerInfo) {
      return { decision: 'offer_unavailable', reason: `Offer PDA ${offerPda.toBase58()} not found` }
    }
    const usdcDecimals = readMintDecimals(usdcMintInfo?.data)
    const onycDecimals = readMintDecimals(onycMintInfo?.data)
    if (usdcDecimals === null || onycDecimals === null) {
      return { decision: 'offer_unavailable', reason: 'mint decimals unreadable' }
    }
    const offerData = offerInfo.data instanceof Uint8Array
      ? offerInfo.data
      : Uint8Array.from(offerInfo.data as unknown as ArrayLike<number>)
    const active = parseActiveOfferVector(offerData, nowUnix)
    const price = calculateStepPrice(active, nowUnix)
    grossExpected = redemptionExpectedOut(onycAmountIn, price, onycDecimals, usdcDecimals)
    navFloor = applySlippageFloor(grossExpected, MAX_SLIPPAGE_BPS)
  } catch (err) {
    return {
      decision: 'offer_unavailable',
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  // Floor known. Try Jupiter; failures downgrade to `quote_failed` but
  // still report the floor so operators know what target to clear.
  try {
    const route = await withTimeout(
      fetchJupiterRoute({
        inputMint: onycMint,
        outputMint: usdcMint,
        amount: onycAmountIn,
        // Jupiter's router-side budget. Independent of the relayer's
        // NAV-anchored floor — both gates must pass.
        slippageBps: MAX_SLIPPAGE_BPS,
        // Real relayer-authority PDA so the SDK's signer-bit sanitization
        // fires on the right meta and the route is valid for an auto-fire
        // path. Passing the wrong key here would produce a route that
        // cannot be submitted.
        userPublicKey: relayerAuthorityPda,
        fetchImpl,
      }),
      rpcTimeoutMs,
      'quoteRedeemOnycRecovery.fetchJupiterRoute',
    )

    return {
      decision: 'quoted',
      navFloor,
      grossExpected,
      quotedOut: route.quotedOutAmount,
      clearsFloor: route.quotedOutAmount >= navFloor,
      addressLookupTables: route.addressLookupTables,
      swapIxData: route.ixData,
      swapAccounts: route.routeAccounts,
    }
  } catch (err) {
    return {
      decision: 'quote_failed',
      navFloor,
      grossExpected,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
