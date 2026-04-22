use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::error::RelayerError;
use crate::state::RelayerConfig;

/// Step two of the two-step authority rotation. The pending authority
/// signs to atomically promote `pending_authority` → `authority` and
/// clear the proposal slot. Errors:
/// `PendingAuthorityMismatch` if signer ≠ proposed key,
/// `NoPendingAuthority` if no rotation is in flight.
///
/// The current authority does not participate — by design, so two
/// independent multisigs can rotate without atomic cross-multisig
/// coordination. Until acceptance, the current authority retains full
/// control (typo-resistant via `configure`).
pub fn handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.relayer_config;

    let pending = config
        .pending_authority
        .ok_or(RelayerError::NoPendingAuthority)?;

    require_keys_eq!(
        ctx.accounts.pending_authority.key(),
        pending,
        RelayerError::PendingAuthorityMismatch
    );

    config.authority = pending;
    config.pending_authority = None;

    msg!(
        "Relayer authority rotated. New authority: {}.",
        config.authority,
    );

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    /// Must equal `relayer_config.pending_authority`.
    pub pending_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,
}
