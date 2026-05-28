//! OnRe instruction arg layouts.
//!
//! These mirror the upstream Anchor handler signatures. When OnRe rev's an
//! instruction's args struct, this is the one file that must change in
//! lock-step. Discriminators and account-slot indices live next to them in
//! `constants.rs` for the same reason.

use anchor_lang::prelude::*;

use crate::constants::{
    ONRE_APR_SCALE, ONRE_DEPOSIT_OFFER_SEED, ONRE_OFFER_ACCOUNT_SIZE, ONRE_OFFER_MAX_VECTORS,
    ONRE_OFFER_VECTORS_OFFSET, ONRE_OFFER_VECTOR_SIZE, ONRE_PRICE_DENOMINATOR, ONRE_PROGRAM_ID,
    ONRE_SECONDS_IN_YEAR,
};
use crate::error::RelayerError;

#[derive(AnchorSerialize)]
pub struct OnreTakeOfferArgs {
    pub amount: u64,
    pub approval_message: Option<Vec<u8>>,
}

/// Mirror of `OfferVector` in
/// `onre-finance/onre-sol/programs/onreapp/src/instructions/offer/offer_state.rs`.
/// Five back-to-back `u64`s (40 bytes); upstream declares `#[zero_copy]
/// #[repr(C)]` so layout is well-defined.
///
/// `start_time` governs active-vector selection; `base_time` is the
/// reference moment the price-growth math integrates from. They are
/// commonly equal but can diverge when a vector is added with a
/// retroactive `base_time`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OnreOfferVector {
    pub start_time: u64,
    pub base_time: u64,
    pub base_price: u64,
    pub apr: u64,
    pub price_fix_duration: u64,
}

/// Read the active pricing vector for `now` from a serialized OnRe `Offer`
/// account.
///
/// Mirrors OnRe's `find_active_vector_at`: among vectors with
/// `start_time != 0 && start_time <= now`, picks the one with the
/// largest `start_time`. Returns `OnreNoActiveVector` if none qualify
/// (e.g. all slots zeroed, or all vectors are in the future).
///
/// Reads exactly `ONRE_OFFER_MAX_VECTORS` slots — the full pinned layout.
/// If upstream ever *grows* the array, the `ONRE_OFFER_ACCOUNT_SIZE` length
/// check above and `offer_layout_matches_fixture` would fire first; absent
/// that, missing a newer (higher-price) vector would select an older,
/// lower-price one and *under*-state the NAV floor — i.e. weaken
/// protection, not fail safe. The size pin + fixture tripwire are the guard.
pub fn parse_active_offer_vector(data: &[u8], now: u64) -> Result<OnreOfferVector> {
    require!(
        data.len() >= ONRE_OFFER_ACCOUNT_SIZE,
        RelayerError::OnreOfferTooShort
    );

    let mut best: Option<OnreOfferVector> = None;
    for i in 0..ONRE_OFFER_MAX_VECTORS {
        let off = ONRE_OFFER_VECTORS_OFFSET + i * ONRE_OFFER_VECTOR_SIZE;
        let v = OnreOfferVector {
            start_time: u64::from_le_bytes(data[off..off + 8].try_into().unwrap()),
            base_time: u64::from_le_bytes(data[off + 8..off + 16].try_into().unwrap()),
            base_price: u64::from_le_bytes(data[off + 16..off + 24].try_into().unwrap()),
            apr: u64::from_le_bytes(data[off + 24..off + 32].try_into().unwrap()),
            price_fix_duration: u64::from_le_bytes(data[off + 32..off + 40].try_into().unwrap()),
        };
        if v.start_time == 0 || v.start_time > now {
            continue;
        }
        match best {
            None => best = Some(v),
            Some(cur) if v.start_time > cur.start_time => best = Some(v),
            _ => {}
        }
    }

    best.ok_or_else(|| error!(RelayerError::OnreNoActiveVector))
}

/// Step-snapped redemption price in 1e9 fixed-point. Byte-for-byte mirror
/// of OnRe's `calculate_step_price_at` + `calculate_vector_price`.
///
/// Snaps to the END of the current discrete interval (`(step + 1) *
/// price_fix_duration`), matching OnRe — meaning the price one second
/// into a new interval is already the price at the end of that
/// interval. Our floor must match this snap exactly, or
/// `swap_onyc_to_usdc`'s NAV gate would diverge from OnRe's accounting
/// and produce an exploitable asymmetry.
pub fn calculate_step_price(v: &OnreOfferVector, now: u64) -> Result<u64> {
    require!(v.base_time <= now, RelayerError::OnreNoActiveVector);
    require!(v.price_fix_duration > 0, RelayerError::OnreNoActiveVector);

    let elapsed = now.saturating_sub(v.base_time);
    let step = elapsed / v.price_fix_duration;
    let step_end = step
        .checked_add(1)
        .and_then(|s| s.checked_mul(v.price_fix_duration))
        .ok_or(RelayerError::OnreNavOverflow)?;

    let factor_den = ONRE_APR_SCALE
        .checked_mul(ONRE_SECONDS_IN_YEAR)
        .ok_or(RelayerError::OnreNavOverflow)?;
    let y_part = (v.apr as u128)
        .checked_mul(step_end as u128)
        .ok_or(RelayerError::OnreNavOverflow)?;
    let factor_num = factor_den
        .checked_add(y_part)
        .ok_or(RelayerError::OnreNavOverflow)?;

    let price_u128 = (v.base_price as u128)
        .checked_mul(factor_num)
        .ok_or(RelayerError::OnreNavOverflow)?
        .checked_div(factor_den)
        .ok_or(RelayerError::OnreNavOverflow)?;

    u64::try_from(price_u128).map_err(|_| error!(RelayerError::OnreNavOverflow))
}

/// Pin `onre_offer` to OnRe's deposit `Offer` PDA for `(usdc_mint,
/// onyc_mint)` and return its step-snapped NAV price (1e9 fp). Both swap
/// legs anchor their slippage floor on this single on-chain oracle read,
/// so the owner/PDA/mint validation lives here once.
pub fn read_offer_nav_price(
    onre_offer: &AccountInfo,
    usdc_mint: &Pubkey,
    onyc_mint: &Pubkey,
    now_unix: u64,
) -> Result<u64> {
    require_keys_eq!(
        *onre_offer.owner,
        ONRE_PROGRAM_ID,
        RelayerError::OnreOfferOwnerMismatch
    );
    let (expected_offer_pda, _bump) = Pubkey::find_program_address(
        &[
            ONRE_DEPOSIT_OFFER_SEED,
            usdc_mint.as_ref(),
            onyc_mint.as_ref(),
        ],
        &ONRE_PROGRAM_ID,
    );
    require_keys_eq!(
        onre_offer.key(),
        expected_offer_pda,
        RelayerError::OnreOfferAddressMismatch
    );

    let offer_data = onre_offer.try_borrow_data()?;
    require!(
        offer_data.len() >= ONRE_OFFER_ACCOUNT_SIZE,
        RelayerError::OnreOfferTooShort
    );
    let in_mint = Pubkey::try_from(&offer_data[8..40])
        .map_err(|_| error!(RelayerError::OnreOfferTooShort))?;
    let out_mint = Pubkey::try_from(&offer_data[40..72])
        .map_err(|_| error!(RelayerError::OnreOfferTooShort))?;
    require_keys_eq!(
        in_mint,
        *usdc_mint,
        RelayerError::OnreOfferTokenInMintMismatch
    );
    require_keys_eq!(
        out_mint,
        *onyc_mint,
        RelayerError::OnreOfferTokenOutMintMismatch
    );

    let active = parse_active_offer_vector(&offer_data, now_unix)?;
    calculate_step_price(&active, now_unix)
}

/// Gross USDC value of redeeming `token_in_amount` at `price` (1e9 fp),
/// mirroring OnRe's `process_redemption_core` output formula:
///
/// ```text
/// out = token_in * price * 10^token_out_decimals
///       / (10^token_in_decimals * 10^9)
/// ```
///
/// Returns the **gross** (pre-fee) amount. The relayer's withdraw fee is
/// taken separately upstream and OnRe's own redemption fee does not apply
/// to this path (this fires when OnRe has already cancelled — refunding
/// ONyc unswapped, no fee charged), so subtracting either here would
/// artificially depress the floor and concede that delta to the operator.
pub fn redemption_expected_out(
    token_in_amount: u64,
    price: u64,
    token_in_decimals: u8,
    token_out_decimals: u8,
) -> Result<u64> {
    let pow_out = 10u128
        .checked_pow(token_out_decimals as u32)
        .ok_or(RelayerError::OnreNavOverflow)?;
    let pow_in = 10u128
        .checked_pow(token_in_decimals as u32)
        .ok_or(RelayerError::OnreNavOverflow)?;

    let num = (token_in_amount as u128)
        .checked_mul(price as u128)
        .and_then(|x| x.checked_mul(pow_out))
        .ok_or(RelayerError::OnreNavOverflow)?;
    let den = pow_in
        .checked_mul(ONRE_PRICE_DENOMINATOR)
        .ok_or(RelayerError::OnreNavOverflow)?;

    u64::try_from(num / den).map_err(|_| error!(RelayerError::OnreNavOverflow))
}

/// Algebraic inverse of `redemption_expected_out` for the deposit leg
/// (USDC in → ONyc out), mirroring OnRe's `process_take_offer` pricing
/// under the assumption both directions clear at the same step `price`:
///
/// ```text
/// out = usdc_in * 10^onyc_decimals * 10^9
///       / (price * 10^usdc_decimals)
/// ```
///
/// Returns the **gross** (pre-fee) ONyc the relayer should receive. The
/// caller applies the slippage floor for rounding headroom; OnRe's own
/// deposit fee (if any) is taken inside `take_offer`, so the floor is set
/// off the post-fee delta the caller observes.
pub fn deposit_expected_out(
    usdc_in_amount: u64,
    price: u64,
    usdc_decimals: u8,
    onyc_decimals: u8,
) -> Result<u64> {
    require!(price > 0, RelayerError::OnreNoActiveVector);
    let pow_out = 10u128
        .checked_pow(onyc_decimals as u32)
        .ok_or(RelayerError::OnreNavOverflow)?;
    let pow_in = 10u128
        .checked_pow(usdc_decimals as u32)
        .ok_or(RelayerError::OnreNavOverflow)?;

    let num = (usdc_in_amount as u128)
        .checked_mul(pow_out)
        .and_then(|x| x.checked_mul(ONRE_PRICE_DENOMINATOR))
        .ok_or(RelayerError::OnreNavOverflow)?;
    let den = (price as u128)
        .checked_mul(pow_in)
        .ok_or(RelayerError::OnreNavOverflow)?;

    u64::try_from(num / den).map_err(|_| error!(RelayerError::OnreNavOverflow))
}

/// Apply a basis-point slippage haircut to a gross expected output.
///
/// Fail-closed on `slippage_bps > 10_000`: a deploy-time typo must produce
/// a loud revert, not a silent zero floor that disables the permissionless
/// `swap_onyc_to_usdc` safety pillar. `slippage_bps == 10_000` is allowed
/// and yields a zero floor — the caller's compile-time constant is the gate.
pub fn apply_slippage_floor(gross_expected: u64, slippage_bps: u16) -> Result<u64> {
    require!(slippage_bps <= 10_000, RelayerError::OnreInvalidSlippageBps);
    let factor = 10_000u128 - slippage_bps as u128;
    let prod = (gross_expected as u128)
        .checked_mul(factor)
        .ok_or(RelayerError::OnreNavOverflow)?;
    u64::try_from(prod / 10_000).map_err(|_| error!(RelayerError::OnreNavOverflow))
}
