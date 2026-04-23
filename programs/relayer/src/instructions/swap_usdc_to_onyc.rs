use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_INBOUND_SEED, ONRE_PROGRAM_ID, ONRE_TAKE_OFFER_IX, REDEMPTION_TRACKER_SEED,
    RELAYER_SEED,
};
use crate::cpi::{invoke_relayer_signed, relayer_signed_transfer_checked};
use crate::error::RelayerError;
use crate::events::OnycSwapped;
use crate::onre::OnreTakeOfferArgs;
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// Permissionless. Swaps the flow's USDC into ONyc via OnRe, then takes the
/// deposit-leg fee from the ONyc output and routes it to `fee_vault`.
/// Operates on `flow.amount` (not full ATA balance) so concurrent flows
/// stay isolated.
///
/// ## Single-authority, mutex-gated
///
/// `usdc_ata` and `onyc_ata` are both owned by `relayer_authority`, which
/// signs the OnRe CPI directly (OnRe enforces `user_token_in_account` and
/// `user_token_out_account` to `associated_token::authority = user`, so
/// passing `relayer_authority` as `user` satisfies that constraint with no
/// intermediate ATA pair).
///
/// Withdraw-chain isolation is provided by the `redemption_tracker`
/// `SystemAccount` gate: while a withdraw redemption is in flight the
/// tracker exists (program-owned), this constraint fails, and deposit
/// traffic pauses. That's what keeps `claim_redemption_usdc`'s
/// snapshot/delta math on `usdc_ata` correct without needing a separate
/// deposit-side ATA.
pub fn handler<'info>(ctx: Context<'info, SwapUsdcToOnyc<'info>>) -> Result<()> {
    let flow_key = ctx.accounts.inflight_flow.key();

    require!(
        ctx.accounts.inflight_flow.status == FlowStatus::Claimed,
        RelayerError::FlowStatusMismatch
    );
    require!(
        ctx.accounts.inflight_flow.amount > 0,
        RelayerError::ZeroAmountFlow
    );

    let onyc_pre = ctx.accounts.onyc_ata.amount;

    invoke_relayer_signed(
        ONRE_PROGRAM_ID,
        &ONRE_TAKE_OFFER_IX,
        &OnreTakeOfferArgs {
            amount: ctx.accounts.inflight_flow.amount,
            approval_message: None,
        },
        ctx.remaining_accounts,
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
    )?;

    ctx.accounts.onyc_ata.reload()?;
    let gross = ctx
        .accounts
        .onyc_ata
        .amount
        .checked_sub(onyc_pre)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(gross > 0, RelayerError::ZeroAmountFlow);

    // Deposit fee taken POST-swap from the ONyc output, on the same
    // authority-owned `onyc_ata` that just received the swap proceeds.
    let (net, fee) = ctx.accounts.relayer_config.apply_deposit_fee(gross)?;

    relayer_signed_transfer_checked(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.onyc_ata.to_account_info(),
        &ctx.accounts.onyc_mint.to_account_info(),
        &ctx.accounts.fee_vault.to_account_info(),
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
        fee,
        ctx.accounts.onyc_mint.decimals,
    )?;

    let flow = &mut ctx.accounts.inflight_flow;
    flow.amount = net;
    flow.status = FlowStatus::Swapped;

    emit!(OnycSwapped {
        flow: flow_key,
        gross_amount: gross,
        fee_amount: fee,
        net_amount: net,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SwapUsdcToOnyc<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = usdc_mint,
        has_one = onyc_mint,
        has_one = fee_vault,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED. Signs the OnRe CPI (as `user`)
    /// and the post-swap fee transfer.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub onyc_mint: InterfaceAccount<'info, Mint>,

    /// USDC source for OnRe `take_offer_permissionless`. Owned by
    /// `relayer_authority`; OnRe enforces `user_token_in_account.authority
    /// == user`, satisfied because the relayer authority signs the CPI as
    /// `user`. Boxed for stack budget.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// ONyc destination for the swap; also the source of the post-swap fee
    /// transfer. Same authority story as `usdc_ata`.
    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Pinned by `has_one = fee_vault`. Any pre-existing ONyc account; need
    /// not be relayer-owned.
    #[account(
        mut,
        token::mint = onyc_mint,
        token::token_program = token_program,
    )]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Withdraw-chain mutex gate. `SystemAccount` asserts
    /// `owner == system_program::ID`, true iff the singleton
    /// `RedemptionTracker` PDA does NOT currently exist. While a withdraw
    /// redemption is in flight this fails, pausing deposits so the
    /// snapshot/delta math in `claim_redemption_usdc` stays correct.
    #[account(
        seeds = [REDEMPTION_TRACKER_SEED],
        bump,
    )]
    pub redemption_tracker: SystemAccount<'info>,

    /// CHECK: validated transitively via the flow PDA seeds.
    pub gateway_claim: UncheckedAccount<'info>,

    /// Created by `claim_usdc`; must be in `Claimed` status.
    #[account(
        mut,
        seeds = [FLOW_INBOUND_SEED, gateway_claim.key().as_ref()],
        bump = inflight_flow.bump,
    )]
    pub inflight_flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
}
