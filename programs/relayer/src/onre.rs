//! OnRe instruction arg layouts, mirrored from upstream Anchor signatures.

use anchor_lang::prelude::*;

use crate::{
    constants::{
        ONRE_APR_SCALE, ONRE_DEPOSIT_OFFER_SEED, ONRE_OFFER_ACCOUNT_SIZE, ONRE_OFFER_MAX_VECTORS,
        ONRE_OFFER_VECTOR_SIZE, ONRE_OFFER_VECTORS_OFFSET, ONRE_PRICE_DENOMINATOR, ONRE_PROGRAM_ID,
        ONRE_SECONDS_IN_YEAR,
    },
    error::RelayerError,
    state::Direction,
};

/// Mirror of upstream OnRe's `OfferVector` (offer_state.rs): five back-to-back
/// `u64`s, 40 bytes, `#[zero_copy] #[repr(C)]`. `start_time` selects the active
/// vector; `base_time` is where the price-growth math integrates from (usually
/// equal, but can diverge on a retroactive `base_time`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OnreOfferVector {
    pub start_time: u64,
    pub base_time: u64,
    pub base_price: u64,
    pub apr: u64,
    pub price_fix_duration: u64,
}

/// Decode a little-endian `u64` at `off`. Callers operate on a slice already
/// length-checked to `ONRE_OFFER_ACCOUNT_SIZE`, so indexing cannot panic.
fn read_u64_le(data: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(data[off..off + 8].try_into().unwrap())
}

/// Decode one 40-byte `OfferVector` (five back-to-back `u64`s) at `off`.
fn read_offer_vector(data: &[u8], off: usize) -> OnreOfferVector {
    OnreOfferVector {
        start_time: read_u64_le(data, off),
        base_time: read_u64_le(data, off + 8),
        base_price: read_u64_le(data, off + 16),
        apr: read_u64_le(data, off + 24),
        price_fix_duration: read_u64_le(data, off + 32),
    }
}

/// Active pricing vector for `now`, mirroring OnRe's `find_active_vector_at`:
/// among slots with `start_time != 0 && start_time <= now`, the largest
/// `start_time` wins (`OnreNoActiveVector` if none qualify).
///
/// Scans all `ONRE_OFFER_MAX_VECTORS` slots; the `ONRE_OFFER_ACCOUNT_SIZE` pin
/// and `offer_layout_matches_fixture` guard against upstream growing the array,
/// which would otherwise under-state the NAV floor.
pub fn parse_active_offer_vector(data: &[u8], now: u64) -> Result<OnreOfferVector> {
    require!(data.len() >= ONRE_OFFER_ACCOUNT_SIZE, RelayerError::OnreOfferTooShort);

    (0..ONRE_OFFER_MAX_VECTORS)
        .map(|i| read_offer_vector(data, ONRE_OFFER_VECTORS_OFFSET + i * ONRE_OFFER_VECTOR_SIZE))
        .filter(|v| v.start_time != 0 && v.start_time <= now)
        .reduce(|best, v| if v.start_time > best.start_time { v } else { best })
        .ok_or_else(|| error!(RelayerError::OnreNoActiveVector))
}

/// Step-snapped redemption price (1e9 fp); mirror of OnRe's
/// `calculate_step_price_at` + `calculate_vector_price`. Snaps to the END of
/// the current interval (`(step + 1) * price_fix_duration`); the floor must
/// match this snap exactly or the `swap` NAV gate diverges from OnRe.
pub fn calculate_step_price(v: &OnreOfferVector, now: u64) -> Result<u64> {
    require!(v.base_time <= now, RelayerError::OnreNoActiveVector);
    require!(v.price_fix_duration > 0, RelayerError::OnreNoActiveVector);

    let elapsed = now.saturating_sub(v.base_time);
    let step = elapsed / v.price_fix_duration;
    let step_end =
        step.checked_add(1).and_then(|s| s.checked_mul(v.price_fix_duration)).ok_or(RelayerError::OnreNavOverflow)?;

    let factor_den = ONRE_APR_SCALE.checked_mul(ONRE_SECONDS_IN_YEAR).ok_or(RelayerError::OnreNavOverflow)?;
    let y_part = (v.apr as u128).checked_mul(step_end as u128).ok_or(RelayerError::OnreNavOverflow)?;
    let factor_num = factor_den.checked_add(y_part).ok_or(RelayerError::OnreNavOverflow)?;

    let price_u128 = (v.base_price as u128)
        .checked_mul(factor_num)
        .ok_or(RelayerError::OnreNavOverflow)?
        .checked_div(factor_den)
        .ok_or(RelayerError::OnreNavOverflow)?;

    u64::try_from(price_u128).map_err(|_| error!(RelayerError::OnreNavOverflow))
}

/// Pin `onre_offer` to OnRe's deposit `Offer` PDA for `(usdc_mint, onyc_mint)`
/// and return its step-snapped NAV price (1e9 fp). Both swap legs anchor their
/// slippage floor here, so owner/PDA/mint validation lives in one place.
pub fn read_offer_nav_price(
    onre_offer: &AccountInfo,
    usdc_mint: &Pubkey,
    onyc_mint: &Pubkey,
    now_unix: u64,
) -> Result<u64> {
    require_keys_eq!(*onre_offer.owner, ONRE_PROGRAM_ID, RelayerError::OnreOfferOwnerMismatch);
    let (expected_offer_pda, _bump) = Pubkey::find_program_address(
        &[ONRE_DEPOSIT_OFFER_SEED, usdc_mint.as_ref(), onyc_mint.as_ref()],
        &ONRE_PROGRAM_ID,
    );
    require_keys_eq!(onre_offer.key(), expected_offer_pda, RelayerError::OnreOfferAddressMismatch);

    let offer_data = onre_offer.try_borrow_data()?;
    require!(offer_data.len() >= ONRE_OFFER_ACCOUNT_SIZE, RelayerError::OnreOfferTooShort);

    let in_mint = Pubkey::try_from(&offer_data[8..40]).map_err(|_| error!(RelayerError::OnreOfferTooShort))?;
    let out_mint = Pubkey::try_from(&offer_data[40..72]).map_err(|_| error!(RelayerError::OnreOfferTooShort))?;
    require_keys_eq!(in_mint, *usdc_mint, RelayerError::OnreOfferTokenInMintMismatch);
    require_keys_eq!(out_mint, *onyc_mint, RelayerError::OnreOfferTokenOutMintMismatch);

    let active = parse_active_offer_vector(&offer_data, now_unix)?;
    calculate_step_price(&active, now_unix)
}

/// Gross (pre-fee) USDC from redeeming `token_in_amount` at `price` (1e9 fp),
/// mirroring OnRe's `process_redemption_core`:
///
/// ```text
/// out = token_in * price * 10^token_out_decimals
///       / (10^token_in_decimals * 10^9)
/// ```
///
/// Gross on purpose: the withdraw fee is taken upstream and OnRe charges no
/// redemption fee on this (already-cancelled) path, so netting here would
/// understate the floor.
pub fn redemption_expected_out(
    token_in_amount: u64,
    price: u64,
    token_in_decimals: u8,
    token_out_decimals: u8,
) -> Result<u64> {
    let pow_out = 10u128.checked_pow(token_out_decimals as u32).ok_or(RelayerError::OnreNavOverflow)?;
    let pow_in = 10u128.checked_pow(token_in_decimals as u32).ok_or(RelayerError::OnreNavOverflow)?;

    let num = (token_in_amount as u128)
        .checked_mul(price as u128)
        .and_then(|x| x.checked_mul(pow_out))
        .ok_or(RelayerError::OnreNavOverflow)?;
    let den = pow_in.checked_mul(ONRE_PRICE_DENOMINATOR).ok_or(RelayerError::OnreNavOverflow)?;

    u64::try_from(num / den).map_err(|_| error!(RelayerError::OnreNavOverflow))
}

/// Algebraic inverse of `redemption_expected_out` for the deposit leg
/// (USDC in → ONyc out), mirroring OnRe's `process_take_offer` at the same
/// step `price`:
///
/// ```text
/// out = usdc_in * 10^onyc_decimals * 10^9
///       / (price * 10^usdc_decimals)
/// ```
///
/// Returns gross (pre-fee) ONyc; the caller applies the slippage floor.
pub fn deposit_expected_out(usdc_in_amount: u64, price: u64, usdc_decimals: u8, onyc_decimals: u8) -> Result<u64> {
    require!(price > 0, RelayerError::OnreNoActiveVector);
    let pow_out = 10u128.checked_pow(onyc_decimals as u32).ok_or(RelayerError::OnreNavOverflow)?;
    let pow_in = 10u128.checked_pow(usdc_decimals as u32).ok_or(RelayerError::OnreNavOverflow)?;

    let num = (usdc_in_amount as u128)
        .checked_mul(pow_out)
        .and_then(|x| x.checked_mul(ONRE_PRICE_DENOMINATOR))
        .ok_or(RelayerError::OnreNavOverflow)?;
    let den = (price as u128).checked_mul(pow_in).ok_or(RelayerError::OnreNavOverflow)?;

    u64::try_from(num / den).map_err(|_| error!(RelayerError::OnreNavOverflow))
}

/// Direction-aware NAV expected-out: deposit converts base→asset (÷ price),
/// withdraw asset→base (× price). `swap_in` is in the input mint's atomic units.
pub fn oracle_expected_out(
    price: u64,
    swap_in: u64,
    direction: Direction,
    base_decimals: u8,
    asset_decimals: u8,
) -> Result<u64> {
    match direction {
        Direction::Deposit => deposit_expected_out(swap_in, price, base_decimals, asset_decimals),
        Direction::Withdraw => redemption_expected_out(swap_in, price, asset_decimals, base_decimals),
    }
}

/// Apply a basis-point slippage haircut to a gross expected output.
///
/// Fail-closed on `slippage_bps > 10_000` so a deploy-time typo reverts loudly
/// instead of silently zeroing the floor. `== 10_000` is allowed (zero floor).
pub fn apply_slippage_floor(gross_expected: u64, slippage_bps: u16) -> Result<u64> {
    require!(slippage_bps <= 10_000, RelayerError::OnreInvalidSlippageBps);
    let factor = 10_000u128 - slippage_bps as u128;
    let prod = (gross_expected as u128).checked_mul(factor).ok_or(RelayerError::OnreNavOverflow)?;
    u64::try_from(prod / 10_000).map_err(|_| error!(RelayerError::OnreNavOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oracle_expected_out_branches_on_direction() {
        let price = 1_000_000_000u64; // 1.0 in 1e9 fp
        let dep = oracle_expected_out(price, 1_000_000, Direction::Deposit, 6, 9).unwrap();
        let wd = oracle_expected_out(price, 1_000_000_000, Direction::Withdraw, 6, 9).unwrap();
        assert_eq!(dep, deposit_expected_out(1_000_000, price, 6, 9).unwrap());
        assert_eq!(wd, redemption_expected_out(1_000_000_000, price, 9, 6).unwrap());
    }

    /// Drift tripwire: parses the real mainnet `Offer` dump (the same
    /// `E88zk…` account the SDK `offer mainnet fixture parity` test reads).
    /// If upstream re-lays out `Offer`, the pinned `ONRE_OFFER_*` offsets
    /// stop selecting this vector and this fails — forcing a lockstep refresh.
    #[test]
    fn offer_layout_matches_fixture() {
        let data: &[u8] = include_bytes!("../../../tests/fixtures/accounts/onre-offer.bin");
        assert_eq!(data.len(), ONRE_OFFER_ACCOUNT_SIZE);

        let active = parse_active_offer_vector(data, 2_000_000_000).unwrap();
        assert_eq!(active.start_time, 1_773_878_400);
        assert_eq!(active.base_price, 1_085_708_975);
        assert_eq!(active.apr, 97_593);
        assert_eq!(active.price_fix_duration, 86_400);

        let price = calculate_step_price(&active, 2_000_000_000).unwrap();
        assert!(price >= active.base_price);
    }

    /// Locks the active-vector selection policy without relying on the live
    /// mainnet dump: zeroed and future-dated slots are skipped, the largest
    /// qualifying `start_time` wins, and ties keep the earliest slot.
    #[test]
    fn selects_latest_started_active_vector() {
        let put = |buf: &mut [u8], slot: usize, start_time: u64, base_price: u64| {
            let off = ONRE_OFFER_VECTORS_OFFSET + slot * ONRE_OFFER_VECTOR_SIZE;
            buf[off..off + 8].copy_from_slice(&start_time.to_le_bytes());
            buf[off + 8..off + 16].copy_from_slice(&start_time.to_le_bytes());
            buf[off + 16..off + 24].copy_from_slice(&base_price.to_le_bytes());
            buf[off + 32..off + 40].copy_from_slice(&86_400u64.to_le_bytes());
        };

        let mut buf = vec![0u8; ONRE_OFFER_ACCOUNT_SIZE];
        put(&mut buf, 0, 1_000, 111);
        put(&mut buf, 1, 3_000, 333); // future vs now=2_500 -> skipped
        put(&mut buf, 2, 2_000, 222); // latest among active; slot 3 zeroed -> skipped
        let active = parse_active_offer_vector(&buf, 2_500).unwrap();
        assert_eq!(active.start_time, 2_000);
        assert_eq!(active.base_price, 222);

        // None qualify once `now` predates every start_time.
        assert!(parse_active_offer_vector(&buf, 999).is_err());

        // Tie on start_time keeps the earliest slot (first-on-tie).
        let mut tie = vec![0u8; ONRE_OFFER_ACCOUNT_SIZE];
        put(&mut tie, 0, 2_000, 222);
        put(&mut tie, 1, 2_000, 999);
        assert_eq!(parse_active_offer_vector(&tie, 2_500).unwrap().base_price, 222);
    }
}
