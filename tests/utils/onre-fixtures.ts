/**
 * LiteSVM-only OnRe fixture helpers.
 *
 * The SDK ships canonical PDA helpers + fixture pubkeys in
 * `@fogo-onre/sdk` (`packages/sdk/src/onre.ts`). This file holds
 * test-only mutators that patch the cloned mainnet fixture bytes — they
 * have no place in production SDK code because they reach into LiteSVM's
 * raw-account API and depend on local fixture file paths.
 */

import type { LiteSVM } from 'litesvm'
import {
  findOnreOfferPda,
  OFFER_TOKEN_IN_MINT_OFFSET,
  OFFER_TOKEN_OUT_MINT_OFFSET,
  ONRE_OFFER_FIXTURE,
  ONRE_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { readFixtureBytes } from './fixture-loader'

/**
 * Pricing-vector layout inside the OnRe Offer account. Each vector is 40
 * bytes laid out as: start_time(8) + effective_start(8) + base_price(8) +
 * apr(8) + duration(8). The fixture's last vector starts at offset 152, so
 * its `duration` field sits at 152 + 32 = 184.
 */
const LAST_PRICING_VECTOR_DURATION_OFFSET = 184

/** Ten years in seconds — long enough that any test-time clock falls inside. */
const TEN_YEARS_SECONDS = 315_360_000n

/**
 * Load the mainnet OnRe Offer fixture, patch the in/out mints to the test's
 * dynamically-created mints, extend the last pricing vector to 10 years
 * (so it remains active under any test clock), and inject the patched
 * bytes at the PDA derived from `(testUsdcMint, testOnycMint)`.
 *
 * Returns the derived offer PDA.
 */
export function loadAndPatchOnreOffer(
  svm: LiteSVM,
  testUsdcMint: PublicKey,
  testOnycMint: PublicKey,
): PublicKey {
  const data = readFixtureBytes(ONRE_OFFER_FIXTURE)

  data.set(testUsdcMint.toBytes(), OFFER_TOKEN_IN_MINT_OFFSET)
  data.set(testOnycMint.toBytes(), OFFER_TOKEN_OUT_MINT_OFFSET)

  // Extend the last pricing vector's duration so it covers the test clock.
  const view = new DataView(data.buffer, data.byteOffset)
  view.setBigUint64(LAST_PRICING_VECTOR_DURATION_OFFSET, TEN_YEARS_SECONDS, true)

  const [offerPda] = findOnreOfferPda(testUsdcMint, testOnycMint)

  svm.setAccount(offerPda, {
    executable: false,
    owner: ONRE_PROGRAM_ID,
    lamports: 5_122_560,
    data,
    rentEpoch: 0,
  })

  return offerPda
}

