use anchor_lang::prelude::*;

use crate::state::GlobalConfig;

/// One-time deploy bootstrap: create the global config and set the admin.
pub fn handler(ctx: Context<Bootstrap>) -> Result<()> {
    let config = &mut ctx.accounts.global_config;
    config.admin = ctx.accounts.admin.key();
    config.pending_admin = None;
    config.bump = ctx.bumps.global_config;

    msg!("Global config bootstrapped. Admin: {}.", config.admin);

    Ok(())
}

#[derive(Accounts)]
pub struct Bootstrap<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [GlobalConfig::SEED],
        bump,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    pub system_program: Program<'info, System>,
}
