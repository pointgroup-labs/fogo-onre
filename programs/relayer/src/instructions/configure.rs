use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{CONFIG_SEED, RELAYER_SEED};
use crate::error::RelayerError;
use crate::state::RelayerConfig;

/// Authority-only. All inputs optional:
///
/// - `deposit_fee_bps` / `withdraw_fee_bps`: `None` leaves unchanged.
/// - `fee_vault`: `None` skips the four supporting accounts and leaves
///   the stored vault unchanged.
/// - `new_authority` (two-step rotation):
///     - `None` — leave `pending_authority` alone
///     - `Some(default())` — cancel any in-flight proposal
///     - `Some(other)` — propose `other`; current authority unchanged
///       until `accept_authority`. A typo is harmless — the current
///       authority can overwrite or cancel before acceptance.
pub fn handler(
    ctx: Context<Configure>,
    deposit_fee_bps: Option<u16>,
    withdraw_fee_bps: Option<u16>,
    new_authority: Option<Pubkey>,
) -> Result<()> {
    let config = &mut ctx.accounts.relayer_config;

    if let Some(bps) = deposit_fee_bps {
        config.deposit_fee_bps = bps;
    }
    if let Some(bps) = withdraw_fee_bps {
        config.withdraw_fee_bps = bps;
    }
    if let Some(vault) = &ctx.accounts.fee_vault {
        require_keys_neq!(
            vault.key(),
            ctx.accounts.onyc_ata.key(),
            RelayerError::FeeVaultAliasesUserAta
        );
        config.fee_vault = vault.key();
    }
    if let Some(proposed) = new_authority {
        config.pending_authority = if proposed == Pubkey::default() {
            None
        } else {
            Some(proposed)
        };
    }
    config.validate()?;

    msg!(
        "Relayer reconfigured. deposit_fee_bps: {}, withdraw_fee_bps: {}, fee_vault: {}, authority: {}, pending_authority: {:?}.",
        config.deposit_fee_bps,
        config.withdraw_fee_bps,
        config.fee_vault,
        config.authority,
        config.pending_authority,
    );

    Ok(())
}

#[derive(Accounts)]
pub struct Configure<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = authority @ RelayerError::UnauthorizedAuthority,
        has_one = onyc_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// Re-derived so the associated-token derivation on `onyc_ata` resolves
    /// for the anti-aliasing constraint.
    /// CHECK: PDA seeds enforce identity.
    #[account(
        seeds = [RELAYER_SEED],
        bump = relayer_config.relayer_authority_bump,
    )]
    pub relayer_authority: UncheckedAccount<'info>,

    pub onyc_mint: InterfaceAccount<'info, Mint>,

    /// Referenced solely to enforce `fee_vault != onyc_ata`.
    #[account(
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: InterfaceAccount<'info, TokenAccount>,

    /// `None` leaves the stored vault unchanged. The anti-aliasing check
    /// runs in the handler — Anchor constraint exprs can't disambiguate
    /// `Option::as_ref` against `InterfaceAccount`'s `AsRef` impls.
    #[account(
        token::mint = onyc_mint,
        token::token_program = token_program,
    )]
    pub fee_vault: Option<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}
