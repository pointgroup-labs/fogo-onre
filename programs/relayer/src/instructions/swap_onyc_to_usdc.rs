use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{CONFIG_SEED, FLOW_OUTBOUND_SEED, RELAYER_SEED};
use crate::error::RelayerError;
use crate::events::UsdcSwapped;
use crate::onre::execute_onre_swap;
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// Permissionless. Takes the withdrawal-leg fee from the flow's ONyc
/// (pre-swap), routes it to `fee_vault`, then swaps the remainder into USDC
/// via OnRe.
pub fn handler<'info>(ctx: Context<'info, SwapOnycToUsdc<'info>>) -> Result<()> {
    let flow_key = ctx.accounts.outflight_flow.key();
    let gross = ctx.accounts.outflight_flow.amount;

    // Status check before the fee transfer — `execute_onre_swap` re-verifies
    // internally, but token movement happens first so we guard here too.
    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::Claimed,
        RelayerError::FlowStatusMismatch
    );

    // Withdrawal fee is taken PRE-swap on the ONyc input.
    let (net, fee) = ctx.accounts.relayer_config.apply_withdraw_fee(gross)?;

    // Physically segregate so `onyc_ata` then holds only the swap-bound `net`.
    if fee > 0 {
        let auth_bump = [ctx.accounts.relayer_config.relayer_authority_bump];
        let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.onyc_ata.to_account_info(),
                    mint: ctx.accounts.onyc_mint.to_account_info(),
                    to: ctx.accounts.fee_vault.to_account_info(),
                    authority: ctx.accounts.relayer_authority.to_account_info(),
                },
                &[auth_seeds],
            ),
            fee,
            ctx.accounts.onyc_mint.decimals,
        )?;
    }

    // Mutate flow.amount = net so the swap consumes only the post-fee
    // remainder. After execute_onre_swap: flow.amount = USDC received,
    // flow.status = Swapped.
    ctx.accounts.outflight_flow.amount = net;
    execute_onre_swap(
        &mut ctx.accounts.outflight_flow,
        &mut ctx.accounts.usdc_ata,
        &ctx.accounts.relayer_authority.to_account_info(),
        &ctx.accounts.relayer_config,
        ctx.remaining_accounts,
    )?;

    let usdc_received = ctx.accounts.outflight_flow.amount;

    emit!(UsdcSwapped {
        flow: flow_key,
        gross_amount: gross,
        fee_amount: fee,
        net_amount: net,
        usdc_received,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SwapOnycToUsdc<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = usdc_mint,
        has_one = onyc_mint,
        has_one = fee_vault,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub onyc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: InterfaceAccount<'info, TokenAccount>,

    /// Pinned by `has_one = fee_vault`. Any pre-existing ONyc account.
    #[account(
        mut,
        token::mint = onyc_mint,
        token::token_program = token_program,
    )]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated transitively via the flow PDA seeds.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    /// Created by `unlock_onyc`; must be in `Claimed` status.
    #[account(
        mut,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = outflight_flow.bump,
    )]
    pub outflight_flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
}
