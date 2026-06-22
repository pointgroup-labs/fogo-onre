//! Two-step global admin rotation.

use anchor_lang::prelude::*;

use crate::{error::RelayerError, state::GlobalConfig};

/// Step one: the current admin proposes a successor.
pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.global_config;
    require_keys_neq!(new_admin, config.admin, RelayerError::PendingAdminIsCurrent);

    config.pending_admin = Some(new_admin);

    msg!("Pending admin set: {}.", new_admin);

    Ok(())
}

/// Step two: the pending admin self-promotes.
pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
    let config = &mut ctx.accounts.global_config;
    let pending = config.pending_admin.ok_or(RelayerError::NoPendingAdmin)?;

    require_keys_eq!(ctx.accounts.pending_admin.key(), pending, RelayerError::PendingAdminMismatch);

    config.admin = pending;
    config.pending_admin = None;

    msg!("Global admin rotated. New admin: {}.", config.admin);

    Ok(())
}

#[derive(Accounts)]
pub struct SetAdmin<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [GlobalConfig::SEED],
        bump = global_config.bump,
        has_one = admin @ RelayerError::UnauthorizedAdmin,
    )]
    pub global_config: Account<'info, GlobalConfig>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,

    #[account(
        mut,
        seeds = [GlobalConfig::SEED],
        bump = global_config.bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,
}
