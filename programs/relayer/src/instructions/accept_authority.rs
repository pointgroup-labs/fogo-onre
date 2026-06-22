use anchor_lang::prelude::*;

use crate::{error::RelayerError, state::PairConfig};

/// Step two of two-step authority rotation: pending authority self-promotes.
pub fn handler(ctx: Context<AcceptAuthority>) -> Result<()> {
    let config = &mut ctx.accounts.pair_config;
    let pending = config.pending_authority.ok_or(RelayerError::NoPendingAuthority)?;

    require_keys_eq!(ctx.accounts.pending_authority.key(), pending, RelayerError::PendingAuthorityMismatch);

    config.authority = pending;
    config.pending_authority = None;

    msg!("Relayer authority rotated. New authority: {}.", config.authority);

    Ok(())
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    pub pending_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PairConfig::SEED, pair_config.base_mint.as_ref(), pair_config.asset_mint.as_ref()],
        bump = pair_config.bump,
    )]
    pub pair_config: Account<'info, PairConfig>,
}
