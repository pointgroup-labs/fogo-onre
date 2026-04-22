use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{CONFIG_SEED, RELAYER_SEED};
use crate::error::RelayerError;
use crate::state::RelayerConfig;

/// Authority-only escape hatch for tokens stranded in the relayer's
/// PDA-owned ATAs. Operational instructions only ever move the exact
/// `Flow.amount` recorded by the inbound bridge step, so any non-flow
/// credit (pre-upgrade commingling, OnRe rounding/dust, accidental
/// transfers, donations, slippage gains, refunds, future bug
/// recoveries) would otherwise be permanently locked behind the PDA.
///
/// No expansion of trust: a malicious authority could already grief
/// users via 100% fees in `configure`. This only adds extraction of
/// non-flow-tracked balances.
///
/// Mint guard (`mint == usdc_mint || mint == onyc_mint`) is
/// belt-and-suspenders — the ATA derivation already pins the
/// relayer-owned ATA for that mint.
pub fn handler(ctx: Context<Sweep>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.relayer_config;
    let mint_key = ctx.accounts.mint.key();
    require!(
        mint_key == config.usdc_mint || mint_key == config.onyc_mint,
        RelayerError::UnauthorizedAuthority
    );

    let auth_bump = [config.relayer_authority_bump];
    let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump];

    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.from.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.relayer_authority.to_account_info(),
            },
            &[auth_seeds],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    msg!(
        "Sweep: {} of mint {} from {} to {}.",
        amount,
        mint_key,
        ctx.accounts.from.key(),
        ctx.accounts.to.key(),
    );

    Ok(())
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = authority @ RelayerError::UnauthorizedAuthority,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED; signs the transfer.
    #[account(
        seeds = [RELAYER_SEED],
        bump = relayer_config.relayer_authority_bump,
    )]
    pub relayer_authority: UncheckedAccount<'info>,

    /// Runtime-constrained to `usdc_mint` or `onyc_mint` from config.
    pub mint: InterfaceAccount<'info, Mint>,

    /// Source — relayer-authority-owned ATA for `mint` (ATA derivation pins).
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub from: InterfaceAccount<'info, TokenAccount>,

    /// Authority's discretion (typically `fee_vault` for ONyc, treasury for USDC).
    #[account(
        mut,
        token::mint = mint,
        token::token_program = token_program,
    )]
    pub to: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}
