use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::constants::{CONFIG_SEED, RELAYER_SEED};
use crate::error::RelayerError;
use crate::state::RelayerConfig;

pub fn handler(
    ctx: Context<Initialize>,
    deposit_fee_bps: u16,
    withdraw_fee_bps: u16,
) -> Result<()> {
    let config = &mut ctx.accounts.relayer_config;
    config.authority = ctx.accounts.authority.key();
    config.pending_authority = None;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.onyc_mint = ctx.accounts.onyc_mint.key();
    config.fee_vault = ctx.accounts.fee_vault.key();
    config.bump = ctx.bumps.relayer_config;
    config.relayer_authority_bump = ctx.bumps.relayer_authority;
    config.deposit_fee_bps = deposit_fee_bps;
    config.withdraw_fee_bps = withdraw_fee_bps;
    // Explicit even though `init` zero-fills.
    config.pending_fee = None;
    config.validate()?;

    msg!(
        "Relayer initialized. USDC ATA: {}. ONyc ATA: {}. Fee vault: {}.",
        ctx.accounts.usdc_ata.key(),
        ctx.accounts.onyc_ata.key(),
        ctx.accounts.fee_vault.key(),
    );

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + RelayerConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED; owns the long-lived ATAs.
    #[account(
        seeds = [RELAYER_SEED],
        bump,
    )]
    pub relayer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    pub onyc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Forbid `fee_vault == onyc_ata` to prevent self-transfer no-ops
    /// that would commingle user funds with fees.
    #[account(
        token::mint = onyc_mint,
        token::token_program = token_program,
        constraint = fee_vault.key() != onyc_ata.key() @ RelayerError::FeeVaultAliasesUserAta,
    )]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
