use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, FEE_TIMELOCK_SLOTS, MAX_FEE_BPS};
use crate::error::RelayerError;

/// `authority` gates governance only; flow instructions are permissionless.
#[account]
#[derive(InitSpace)]
pub struct RelayerConfig {
    pub usdc_mint: Pubkey,
    pub onyc_mint: Pubkey,

    pub authority: Pubkey,
    pub fee_vault: Pubkey,

    pub deposit_fee_bps: u16,
    pub withdraw_fee_bps: u16,

    pub relayer_authority_bump: u8,
    pub bump: u8,

    /// Promoted to `authority` by `accept_authority` (two-step handoff).
    pub pending_authority: Option<Pubkey>,

    /// Staged fee *increase*, auto-promoted on next `configure` once
    /// `ready_slot` elapses. Decreases bypass this.
    pub pending_fee: Option<PendingFee>,
}

#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct PendingFee {
    pub deposit_fee_bps: Option<u16>,

    pub withdraw_fee_bps: Option<u16>,

    /// MAX-extended on later raises so a follow-up never shortens the window.
    pub ready_slot: u64,
}

impl PendingFee {
    pub fn is_empty(&self) -> bool {
        self.deposit_fee_bps.is_none() && self.withdraw_fee_bps.is_none()
    }
}

impl RelayerConfig {
    pub const SEEDS: &'static [u8] = CONFIG_SEED;

    pub fn validate(&self) -> Result<()> {
        require!(
            self.deposit_fee_bps <= MAX_FEE_BPS,
            RelayerError::FeeBpsTooHigh
        );
        require!(
            self.withdraw_fee_bps <= MAX_FEE_BPS,
            RelayerError::FeeBpsTooHigh
        );
        if let Some(p) = &self.pending_fee {
            require!(!p.is_empty(), RelayerError::EmptyPendingFee);
            if let Some(bps) = p.deposit_fee_bps {
                require!(bps <= MAX_FEE_BPS, RelayerError::FeeBpsTooHigh);
            }
            if let Some(bps) = p.withdraw_fee_bps {
                require!(bps <= MAX_FEE_BPS, RelayerError::FeeBpsTooHigh);
            }
        }
        Ok(())
    }

    pub fn apply_deposit_fee(&self, gross: u64) -> Result<(u64, u64)> {
        apply_fee_bps(gross, self.deposit_fee_bps)
    }

    pub fn apply_withdraw_fee(&self, gross: u64) -> Result<(u64, u64)> {
        apply_fee_bps(gross, self.withdraw_fee_bps)
    }

    /// Run at the top of `configure::handler` so a same-call decrease
    /// compares against the just-promoted value, not the stale one.
    pub fn promote_pending_fee_if_ready(&mut self, now: u64) {
        let Some(p) = self.pending_fee else { return };
        if now < p.ready_slot {
            return;
        }
        if let Some(d) = p.deposit_fee_bps {
            self.deposit_fee_bps = d;
        }
        if let Some(w) = p.withdraw_fee_bps {
            self.withdraw_fee_bps = w;
        }
        self.pending_fee = None;
    }

    pub fn propose_deposit_fee(&mut self, proposed: u16, now: u64) -> Result<()> {
        propose_fee_change(
            proposed,
            &mut self.deposit_fee_bps,
            &mut self.pending_fee,
            |p| &mut p.deposit_fee_bps,
            now,
        )
    }

    pub fn propose_withdraw_fee(&mut self, proposed: u16, now: u64) -> Result<()> {
        propose_fee_change(
            proposed,
            &mut self.withdraw_fee_bps,
            &mut self.pending_fee,
            |p| &mut p.withdraw_fee_bps,
            now,
        )
    }
}

/// Asymmetric:
/// - `proposed <= live`: apply instantly, clear this leg.
/// - `proposed >  live`: stage; `ready_slot` MAX-extends so a follow-up
///   raise can't shorten an in-flight window.
fn propose_fee_change(
    proposed: u16,
    live: &mut u16,
    bundle: &mut Option<PendingFee>,
    leg: fn(&mut PendingFee) -> &mut Option<u16>,
    now: u64,
) -> Result<()> {
    if proposed <= *live {
        *live = proposed;
        if let Some(p) = bundle {
            *leg(p) = None;
            if p.is_empty() {
                *bundle = None;
            }
        }
        return Ok(());
    }

    let new_ready = now
        .checked_add(FEE_TIMELOCK_SLOTS)
        .ok_or(RelayerError::FeeOverflow)?;

    let p = bundle.get_or_insert(PendingFee {
        deposit_fee_bps: None,
        withdraw_fee_bps: None,
        ready_slot: new_ready,
    });
    p.ready_slot = p.ready_slot.max(new_ready);
    *leg(p) = Some(proposed);
    Ok(())
}

/// Returns `(net, fee)` with `fee = floor(gross * bps / 10_000)`.
/// `try_from` defense-in-depth: surfaces a future invariant break as
/// `FeeOverflow` instead of silent truncation.
pub(crate) fn apply_fee_bps(gross: u64, bps: u16) -> Result<(u64, u64)> {
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
#[cfg_attr(test, derive(Debug))]
pub enum FlowStatus {
    Claimed,
    Swapped,
}

/// One-shot receipt binding an inbound bridge message to a FOGO wallet.
/// Replay protection lives in the per-VAA NTT claim account. Field set
/// is byte-stable — older PDAs must keep deserializing.
#[account]
#[derive(InitSpace)]
pub struct Flow {
    /// Originator on FOGO; outbound recipient on the return leg.
    pub fogo_sender: [u8; 32],

    pub status: FlowStatus,

    pub amount: u64,

    pub payer: Pubkey,

    pub bump: u8,
}
