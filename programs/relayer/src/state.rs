use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::error::RelayerError;

/// The only long-lived state in this program.
///
/// `authority` is a cold/admin key used only for governance. All operational
/// instructions are permissionless — recipients are VAA-bound, amounts are
/// flow-bound, and CPI targets are compile-time constants.
#[account]
#[derive(InitSpace)]
pub struct RelayerConfig {
    pub authority: Pubkey,

    /// Two-step rotation accommodates multisig→multisig handoffs where the two
    /// parties cannot atomically co-sign (e.g. two independent Squads vaults).
    /// `None` when no rotation is in flight; set by `configure(new_authority)`,
    /// promoted to `authority` by a separate `accept_authority` tx from this key.
    pub pending_authority: Option<Pubkey>,

    pub usdc_mint: Pubkey,
    pub onyc_mint: Pubkey,

    /// Single PDA-addressed token account holding ALL accumulated fees from
    /// both legs (denominated in ONyc).
    pub fee_vault: Pubkey,

    pub bump: u8,
    pub relayer_authority_bump: u8,

    /// Deposit-leg fee in bps (1 bps = 0.01%).
    pub deposit_fee_bps: u16,
    /// Withdrawal-leg fee in bps.
    pub withdraw_fee_bps: u16,
}

impl RelayerConfig {
    pub const SEEDS: &'static [u8] = CONFIG_SEED;

    pub fn validate(&self) -> Result<()> {
        require!(self.deposit_fee_bps <= 10_000, RelayerError::FeeBpsTooHigh);
        require!(self.withdraw_fee_bps <= 10_000, RelayerError::FeeBpsTooHigh);
        Ok(())
    }

    pub fn apply_deposit_fee(&self, gross: u64) -> Result<(u64, u64)> {
        apply_fee_bps(gross, self.deposit_fee_bps)
    }

    pub fn apply_withdraw_fee(&self, gross: u64) -> Result<(u64, u64)> {
        apply_fee_bps(gross, self.withdraw_fee_bps)
    }
}

/// Returns `(net, fee)` where `fee = floor(gross * bps / 10_000)`.
///
/// `try_from` is defense-in-depth — under the `validate()` invariant
/// `fee_u128 <= gross`, so the cast can't overflow today, but enforcing
/// locally turns a future invariant violation into `FeeOverflow` instead of
/// silent truncation.
fn apply_fee_bps(gross: u64, bps: u16) -> Result<(u64, u64)> {
    let fee_u128 = (gross as u128)
        .checked_mul(bps as u128)
        .ok_or(RelayerError::FeeOverflow)?
        / 10_000;
    let fee = u64::try_from(fee_u128).map_err(|_| RelayerError::FeeOverflow)?;
    let net = gross.checked_sub(fee).ok_or(RelayerError::FeeOverflow)?;
    require!(net > 0, RelayerError::ZeroAmountFlow);
    Ok((net, fee))
}

#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum FlowStatus {
    /// Inbound bridge complete, awaiting swap.
    Claimed,
    /// Swap complete, awaiting outbound bridge.
    Swapped,
}

/// One-shot receipt binding an inbound bridge message to a FOGO user wallet.
/// Used by both legs — direction is implicit in the seed prefix
/// (`FLOW_INBOUND_SEED` vs `FLOW_OUTBOUND_SEED`).
///
/// PDA seeds: `[FLOW_*_SEED, bridge_claim_pda.key()]`. Uniqueness and replay
/// protection are delegated to the per-VAA claim account created by Wormhole
/// Gateway / NTT — no hashing needed here.
#[account]
#[derive(InitSpace)]
pub struct Flow {
    /// Originator on FOGO; becomes the outbound recipient on the return leg.
    pub fogo_sender: [u8; 32],

    pub status: FlowStatus,

    /// Token amount for the current/next step.
    pub amount: u64,

    /// Receives rent on close.
    pub payer: Pubkey,

    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err_code(e: Error) -> u32 {
        match e {
            Error::AnchorError(ae) => ae.error_code_number,
            _ => panic!("expected AnchorError, got {e:?}"),
        }
    }

    fn code_of(re: RelayerError) -> u32 {
        // Anchor error codes start at 6000 and increment by declaration order.
        // We compare via the `Discriminator`-style `u32` to keep tests stable
        // even if intermediate variants are added (which would shift numeric
        // codes — a separate concern flagged at audit time).
        (re as u32) + ERROR_CODE_OFFSET
    }

    #[test]
    fn zero_bps_passes_through_full_amount() {
        let (net, fee) = apply_fee_bps(1_000_000, 0).unwrap();
        assert_eq!(net, 1_000_000);
        assert_eq!(fee, 0);
    }

    #[test]
    fn one_bps_one_unit_rounds_fee_to_zero() {
        // floor(1 * 1 / 10_000) = 0 — fees round down (favors user, not vault).
        let (net, fee) = apply_fee_bps(1, 1).unwrap();
        assert_eq!(net, 1);
        assert_eq!(fee, 0);
    }

    #[test]
    fn one_bps_at_threshold_charges_one_unit() {
        // First gross at which a 1-bps fee actually accrues.
        let (net, fee) = apply_fee_bps(10_000, 1).unwrap();
        assert_eq!(net, 9_999);
        assert_eq!(fee, 1);
    }

    #[test]
    fn max_bps_takes_entire_amount_and_rejects_zero_net() {
        // 100% fee leaves the user with 0 — must fail closed, not silently
        // forward a zero-amount transfer to the next CPI.
        let e = apply_fee_bps(1_000, 10_000).unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::ZeroAmountFlow));
    }

    #[test]
    fn near_max_bps_keeps_one_unit() {
        // 99.99% fee on 1M USDC leaves 100 to user.
        let (net, fee) = apply_fee_bps(1_000_000, 9_999).unwrap();
        assert_eq!(fee, 999_900);
        assert_eq!(net, 100);
    }

    #[test]
    fn zero_gross_rejected() {
        // Upstream guards ZeroAmountFlow before we get here; defense-in-depth.
        let e = apply_fee_bps(0, 100).unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::ZeroAmountFlow));
    }

    #[test]
    fn u64_max_with_valid_bps_fits_via_u128_widening() {
        // The whole point of widening to u128 before mul: u64::MAX * 10_000
        // would overflow u64 by ~14 bits. u128 has plenty of headroom.
        let (net, fee) = apply_fee_bps(u64::MAX, 10).unwrap();
        // 10 bps = 0.1%; fee ≈ u64::MAX / 1000.
        assert!(fee > 0);
        assert!(net > 0);
        assert_eq!(net.checked_add(fee).unwrap(), u64::MAX);
    }

    #[test]
    fn u64_max_with_one_bps_yields_minimal_fee() {
        let (net, fee) = apply_fee_bps(u64::MAX, 1).unwrap();
        // fee = floor(u64::MAX / 10_000)
        assert_eq!(fee, u64::MAX / 10_000);
        assert_eq!(net, u64::MAX - fee);
    }

    #[test]
    fn out_of_range_bps_overflows_u64_and_returns_fee_overflow() {
        // `validate()` rejects bps>10_000 at the config layer, but
        // `apply_fee_bps` is the last line of defense if that invariant ever
        // breaks: u64::MAX * 20_000 / 10_000 = 2*u64::MAX, which can't fit
        // back in u64 → FeeOverflow (NOT silent truncation).
        let e = apply_fee_bps(u64::MAX, 20_000).unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::FeeOverflow));
    }

    #[test]
    fn validate_accepts_zero_and_max_fees() {
        let cfg = RelayerConfig {
            authority: Pubkey::default(),
            pending_authority: None,
            usdc_mint: Pubkey::default(),
            onyc_mint: Pubkey::default(),
            fee_vault: Pubkey::default(),
            bump: 0,
            relayer_authority_bump: 0,
            deposit_fee_bps: 0,
            withdraw_fee_bps: 10_000,
        };
        cfg.validate().unwrap();
    }

    #[test]
    fn validate_rejects_above_max() {
        let cfg = RelayerConfig {
            authority: Pubkey::default(),
            pending_authority: None,
            usdc_mint: Pubkey::default(),
            onyc_mint: Pubkey::default(),
            fee_vault: Pubkey::default(),
            bump: 0,
            relayer_authority_bump: 0,
            deposit_fee_bps: 10_001,
            withdraw_fee_bps: 0,
        };
        let e = cfg.validate().unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::FeeBpsTooHigh));
    }
}
