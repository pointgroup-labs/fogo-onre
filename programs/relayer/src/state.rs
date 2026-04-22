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
