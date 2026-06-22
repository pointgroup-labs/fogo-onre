use anchor_lang::prelude::*;

use crate::state::RelayerConfig;

/// Create the global config that gates pair creation. The signer becomes the
/// admin. Singleton, created once (at deploy).
pub fn handler(ctx: Context<Initialize>) -> Result<()> {
    let config = &mut ctx.accounts.relayer_config;
    config.admin = ctx.accounts.admin.key();
    config.bump = ctx.bumps.relayer_config;

    msg!("Relayer config initialized. Admin: {}.", config.admin);

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + RelayerConfig::INIT_SPACE,
        seeds = [RelayerConfig::SEED],
        bump,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    pub system_program: Program<'info, System>,
}
