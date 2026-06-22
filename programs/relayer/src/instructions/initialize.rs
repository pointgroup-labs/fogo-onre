use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::RELAYER_SEED,
    error::RelayerError,
    state::{GlobalConfig, PairConfig},
};

pub fn handler(
    ctx: Context<Initialize>,
    deposit_fee_bps: u16,
    withdraw_fee_bps: u16,
    ntt_base_program: Pubkey,
    ntt_asset_program: Pubkey,
    intent_programs: [Pubkey; 2],
) -> Result<()> {
    let config = &mut ctx.accounts.pair_config;
    config.authority = ctx.accounts.authority.key();
    config.pending_authority = None;
    config.base_mint = ctx.accounts.base_mint.key();
    config.asset_mint = ctx.accounts.asset_mint.key();
    config.fee_vault = ctx.accounts.fee_vault.key();
    config.ntt_base_program = ntt_base_program;
    config.ntt_asset_program = ntt_asset_program;
    config.intent_programs = intent_programs;
    config.bump = ctx.bumps.pair_config;
    config.relayer_authority_bump = ctx.bumps.relayer_authority;
    config.deposit_fee_bps = deposit_fee_bps;
    config.withdraw_fee_bps = withdraw_fee_bps;
    config.pending_fee = None;
    config.validate()?;

    msg!(
        "Pair initialized. Base ATA: {}. Asset ATA: {}. Fee vault: {}.",
        ctx.accounts.base_ata.key(),
        ctx.accounts.asset_ata.key(),
        ctx.accounts.fee_vault.key(),
    );

    Ok(())
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Admin gate: only `global_config.admin` may create pairs.
    #[account(
        seeds = [GlobalConfig::SEED],
        bump = global_config.bump,
        constraint = global_config.admin == authority.key() @ RelayerError::UnauthorizedAdmin,
    )]
    pub global_config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = authority,
        space = 8 + PairConfig::INIT_SPACE,
        seeds = [PairConfig::SEED, base_mint.key().as_ref(), asset_mint.key().as_ref()],
        bump,
    )]
    pub pair_config: Account<'info, PairConfig>,

    /// CHECK: PDA derived from RELAYER_SEED; owns the long-lived ATAs.
    #[account(seeds = [RELAYER_SEED], bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub base_mint: InterfaceAccount<'info, Mint>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = base_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub base_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        payer = authority,
        associated_token::mint = asset_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub asset_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Forbid `fee_vault == asset_ata` to prevent self-transfer no-ops
    /// that would commingle user funds with fees.
    #[account(
        token::mint = asset_mint,
        token::token_program = token_program,
        constraint = fee_vault.key() != asset_ata.key() @ RelayerError::FeeVaultAliasesUserAta,
    )]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
