use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::constants::{CONFIG_SEED, DEPOSIT_AUTHORITY_SEED, REDEEMER_SEED, RELAYER_SEED};
use crate::error::RelayerError;
use crate::state::RelayerConfig;

/// One-shot deployment setup. Creates `RelayerConfig`, the long-lived
/// USDC + ONyc ATAs owned by the relayer authority PDA, and the
/// short-lived USDC intake ATA owned by the redeemer PDA (used as `to`
/// in TB `CompleteWrappedWithPayload` — see `claim_usdc`).
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
    config.validate()?;

    msg!(
        "Relayer initialized. USDC ATA: {}. ONyc ATA: {}. Redeemer USDC intake ATA: {}. Deposit USDC ATA: {}. Deposit ONyc ATA: {}. Fee vault: {}.",
        ctx.accounts.usdc_ata.key(),
        ctx.accounts.onyc_ata.key(),
        ctx.accounts.redeemer_usdc_ata.key(),
        ctx.accounts.deposit_usdc_ata.key(),
        ctx.accounts.deposit_onyc_ata.key(),
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

    /// Serves as TB's payload-delivery signer in `CompleteWrappedWithPayload`
    /// AND owns the short-lived USDC intake ATA (TB requires
    /// `redeemer.key == to.owner`).
    /// CHECK: PDA derived from REDEEMER_SEED.
    #[account(
        seeds = [REDEEMER_SEED],
        bump,
    )]
    pub redeemer_authority: UncheckedAccount<'info>,

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

    /// `claim_usdc` mints into this ATA via TB then immediately sweeps it
    /// to `deposit_usdc_ata` under the redeemer's signature.
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = redeemer_authority,
        associated_token::token_program = token_program,
    )]
    pub redeemer_usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: PDA derived from DEPOSIT_AUTHORITY_SEED; owns the deposit-leg
    /// USDC + ONyc intermediate ATAs. Signs the OnRe `take_offer_permissionless`
    /// CPI in `swap_usdc_to_onyc`. Created here so its bump can be looked up
    /// at runtime via `find_program_address` in the deposit-leg instructions
    /// (we deliberately avoid persisting the bump on `RelayerConfig` to keep
    /// its byte layout backward-compatible across already-allocated PDAs).
    #[account(
        seeds = [DEPOSIT_AUTHORITY_SEED],
        bump,
    )]
    pub deposit_authority: UncheckedAccount<'info>,

    /// Deposit-chain USDC sink: `claim_usdc` sweeps bridged USDC here, then
    /// `swap_usdc_to_onyc` feeds it into OnRe's `take_offer_permissionless`
    /// as `user_token_in_account`. Isolating from `usdc_ata` is what makes
    /// the withdraw-chain delta math safe — see `DEPOSIT_AUTHORITY_SEED`
    /// rationale in `constants.rs`.
    #[account(
        init,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = deposit_authority,
        associated_token::token_program = token_program,
    )]
    pub deposit_usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Transient deposit-chain ONyc sink: OnRe delivers ONyc here as the
    /// permissionless take's `user_token_out_account` (forced by OnRe's
    /// `associated_token::authority = user` constraint). `swap_usdc_to_onyc`
    /// then transfers the received ONyc into `onyc_ata` so `lock_onyc` keeps
    /// its existing read path. Normally zero between instructions.
    #[account(
        init,
        payer = authority,
        associated_token::mint = onyc_mint,
        associated_token::authority = deposit_authority,
        associated_token::token_program = token_program,
    )]
    pub deposit_onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Anti-aliasing constraint: forbidding `fee_vault == onyc_ata`
    /// prevents silent self-transfer no-ops that would commingle user
    /// funds with fees and defeat the vault split.
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
