use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{constants::RELAYER_SEED, error::RelayerError, state::PairConfig};

pub fn handler(
    ctx: Context<Configure>,
    deposit_fee_bps: Option<u16>,
    withdraw_fee_bps: Option<u16>,
    new_authority: Option<Pubkey>,
) -> Result<()> {
    let config = &mut ctx.accounts.pair_config;
    let now = Clock::get()?.slot;

    // Promote ripe staged changes BEFORE merging new args, so a same-call
    // decrease compares against the just-promoted value, not the stale live one.
    config.promote_pending_fee_if_ready(now);

    if let Some(proposed) = deposit_fee_bps {
        config.propose_deposit_fee(proposed, now)?;
    }
    if let Some(proposed) = withdraw_fee_bps {
        config.propose_withdraw_fee(proposed, now)?;
    }

    if let Some(vault) = &ctx.accounts.fee_vault {
        require_keys_neq!(vault.key(), ctx.accounts.asset_ata.key(), RelayerError::FeeVaultAliasesUserAta);
        config.fee_vault = vault.key();
    }
    if let Some(proposed) = new_authority {
        config.pending_authority = if proposed == Pubkey::default() {
            None
        } else {
            require_keys_neq!(proposed, config.authority, RelayerError::PendingAuthorityIsCurrent);
            Some(proposed)
        };
    }
    config.validate()?;

    msg!(
        "Relayer reconfigured. deposit_fee_bps: {}, withdraw_fee_bps: {}, pending_fee: {:?}, fee_vault: {}, \
         authority: {}, pending_authority: {:?}.",
        config.deposit_fee_bps,
        config.withdraw_fee_bps,
        config.pending_fee,
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
        seeds = [PairConfig::SEED, pair_config.base_mint.as_ref(), asset_mint.key().as_ref()],
        bump = pair_config.bump,
        has_one = authority @ RelayerError::UnauthorizedAuthority,
        has_one = asset_mint,
    )]
    pub pair_config: Account<'info, PairConfig>,

    /// CHECK: PDA seeds enforce identity.
    #[account(
        seeds = [RELAYER_SEED],
        bump = pair_config.relayer_authority_bump,
    )]
    pub relayer_authority: UncheckedAccount<'info>,

    pub asset_mint: InterfaceAccount<'info, Mint>,

    #[account(
        associated_token::mint = asset_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub asset_ata: InterfaceAccount<'info, TokenAccount>,

    /// `None` leaves the stored vault unchanged.
    #[account(
        token::mint = asset_mint,
        token::token_program = token_program,
    )]
    pub fee_vault: Option<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}
