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
  findOnreRedemptionOfferPda,
  findOnreRedemptionVaultAuthorityPda,
  OFFER_TOKEN_IN_MINT_OFFSET,
  OFFER_TOKEN_OUT_MINT_OFFSET,
  ONRE_OFFER_FIXTURE,
  ONRE_PROGRAM_ID,
  REDEMPTION_OFFER_BUMP_OFFSET,
  REDEMPTION_OFFER_DISCRIMINATOR,
  REDEMPTION_OFFER_OFFER_OFFSET,
  REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET,
  REDEMPTION_OFFER_SIZE,
  REDEMPTION_OFFER_TOKEN_IN_MINT_OFFSET,
  REDEMPTION_OFFER_TOKEN_OUT_MINT_OFFSET,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
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

/**
 * Synthesize OnRe withdraw-side state needed for a real
 * `request_redemption_onyc` CPI:
 *
 *   1. Inject a 256-byte `RedemptionOffer` account at the PDA derived from
 *      `(testOnycMint, testUsdcMint)` (NOTE: token_in=ONyc, token_out=USDC
 *      — opposite seed order vs deposit Offer). All fields synthesized
 *      from scratch — no mainnet capture needed because the struct layout
 *      is fully known and OnRe's `create_redemption_request` only reads
 *      `offer`, `token_in_mint`, `token_out_mint`, `request_counter`,
 *      `bump`, and writes `requested_redemptions` + bumps `request_counter`.
 *      `fee_basis_points` is OnRe-internal (used by `fulfill_redemption_request`,
 *      not `create_*`), so we set it to 0.
 *
 *   2. Pre-create the redemption vault's ONyc ATA at
 *      `getAssociatedTokenAddressSync(testOnycMint, vaultAuthority, true)`.
 *      `create_redemption_request`'s constraint requires this ATA to
 *      already exist (it's `associated_token::*`, not `init_if_needed`).
 *
 * Returns the `RedemptionOffer` PDA so the caller can read its
 * `request_counter` (always `0` for a freshly synthesized offer) and
 * derive the `RedemptionRequest` PDA.
 */
export function synthesizeOnreRedemptionOffer(
  svm: LiteSVM,
  testOnycMint: PublicKey,
  testUsdcMint: PublicKey,
): { redemptionOffer: PublicKey, vaultAuthority: PublicKey, vaultTokenAccount: PublicKey } {
  // The relayer's deposit-side Offer PDA is referenced as
  // `RedemptionOffer.offer` and validated in `create_redemption_request`
  // via `redemption_offer.offer != Pubkey::default()`. We use the same
  // patched-mint Offer PDA the deposit chain uses; its existence as a
  // synthesized fixture is orthogonal — the redemption-create handler
  // doesn't load the Offer account, only checks that the field is set.
  const [offerPda] = findOnreOfferPda(testUsdcMint, testOnycMint)

  const [redemptionOffer, bump] = findOnreRedemptionOfferPda(
    testOnycMint, testUsdcMint, ONRE_PROGRAM_ID,
  )
  const [vaultAuthority] = findOnreRedemptionVaultAuthorityPda(ONRE_PROGRAM_ID)

  const data = new Uint8Array(REDEMPTION_OFFER_SIZE)
  data.set(REDEMPTION_OFFER_DISCRIMINATOR, 0)
  data.set(offerPda.toBytes(), REDEMPTION_OFFER_OFFER_OFFSET)
  data.set(testOnycMint.toBytes(), REDEMPTION_OFFER_TOKEN_IN_MINT_OFFSET)
  data.set(testUsdcMint.toBytes(), REDEMPTION_OFFER_TOKEN_OUT_MINT_OFFSET)
  // executed_redemptions, requested_redemptions, fee_basis_points: zero.
  // request_counter: zero — first request gets PDA seed [..., 0u64_le].
  new DataView(data.buffer).setBigUint64(
    REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET, 0n, true,
  )
  data[REDEMPTION_OFFER_BUMP_OFFSET] = bump

  svm.setAccount(redemptionOffer, {
    executable: false,
    owner: ONRE_PROGRAM_ID,
    lamports: 2_400_000, // covers rent for 256 bytes
    data,
    rentEpoch: 0,
  })

  // Vault ATA for ONyc. Anchor `associated_token::*` constraint requires
  // it to exist with the right mint+owner+token_program — synthesize the
  // raw 165-byte SPL Token account directly so we don't need an authority
  // signer. Balance starts at zero; `create_redemption_request` transfers
  // the locked ONyc into it during the CPI.
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    testOnycMint, vaultAuthority, true, TOKEN_PROGRAM_ID,
  )
  const acctData = new Uint8Array(165)
  acctData.set(testOnycMint.toBytes(), 0)
  acctData.set(vaultAuthority.toBytes(), 32)
  // amount (u64 LE) at offset 64 — leave zero
  acctData[108] = 1 // state = Initialized
  svm.setAccount(vaultTokenAccount, {
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports: 2_039_280,
    data: acctData,
    rentEpoch: 0,
  })

  return { redemptionOffer, vaultAuthority, vaultTokenAccount }
}
