use anchor_lang::prelude::*;

use crate::{constants::CONFIG_SEED, error::RelayerError, state::RelayerConfig};

/// Step two of two-step authority rotation: pending authority self-promotes.
pub fn handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.relayer_config;

    let pending = config.pending_authority.ok_or(RelayerError::NoPendingAuthority)?;

    require_keys_eq!(ctx.accounts.pending_authority.key(), pending, RelayerError::PendingAuthorityMismatch);

    config.authority = pending;
    config.pending_authority = None;

    msg!("Relayer authority rotated. New authority: {}.", config.authority,);

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,
}
