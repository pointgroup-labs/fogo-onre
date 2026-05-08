//! Withdraw chain recovery hatch: aborts a stuck OnRe redemption (admin
//! outage, kill-switch, KYC issue) and rolls the flow back to `Claimed`.
//!
//! Authority-only: permissionless cancel would be a griefing vector
//! (loop request → cancel → bleed `withdraw_fee_bps` per cycle).

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, ONRE_CANCEL_REDEMPTION_REQUEST_IX,
    ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX, ONRE_PROGRAM_ID,
    REDEMPTION_TRACKER_SEED, RELAYER_SEED,
};
use crate::cpi::invoke_relayer_signed;
use crate::error::RelayerError;
use crate::events::RedemptionCancelled;
use crate::onre::OnreCancelRedemptionRequestArgs;
use crate::state::{Flow, FlowStatus, RedemptionTracker, RelayerConfig};

pub fn handler<'info>(ctx: Context<'info, CancelRedemptionOnyc<'info>>) -> Result<()> {
    let flow_key = ctx.accounts.outflight_flow.key();
    let tracker = &ctx.accounts.redemption_tracker;

    // Defense in depth on top of the singleton-PDA seed binding.
    require_keys_eq!(
        tracker.flow,
        flow_key,
        RelayerError::RedemptionTrackerFlowMismatch
    );

    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::RedemptionPending,
        RelayerError::FlowStatusMismatch
    );

    require!(
        ctx.remaining_accounts.len() > ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX,
        RelayerError::InvalidAccountSplit
    );

    // Pin the redemption_request slot to the tracker's record. Without
    // this, a malicious authority could pass a different
    // RedemptionRequest in slot 2 — OnRe's seed validation would still
    // pass, but the returned ONyc would belong to whoever opened it.
    let cpi_redemption_request_key =
        *ctx.remaining_accounts[ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX].key;
    require_keys_eq!(
        cpi_redemption_request_key,
        tracker.redemption_request,
        RelayerError::RedemptionRequestMismatch
    );

    invoke_relayer_signed(
        ONRE_PROGRAM_ID,
        &ONRE_CANCEL_REDEMPTION_REQUEST_IX,
        &OnreCancelRedemptionRequestArgs {},
        ctx.remaining_accounts,
        Some(&ctx.accounts.relayer_authority.to_account_info()),
        ctx.accounts.relayer_config.relayer_authority_bump,
    )?;

    let returned = tracker.onyc_amount_in;
    let redemption_request = tracker.redemption_request;

    let flow = &mut ctx.accounts.outflight_flow;
    flow.amount = returned;
    flow.status = FlowStatus::Claimed;

    emit!(RedemptionCancelled {
        flow: flow_key,
        redemption_request,
        returned_onyc_amount: returned,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CancelRedemptionOnyc<'info> {
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = authority @ RelayerError::UnauthorizedAuthority,
        has_one = onyc_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA seeds enforce identity. Recorded as redeemer inside
    /// `redemption_request`, so unlocked ONyc returns to its `onyc_ata`.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub onyc_mint: InterfaceAccount<'info, Mint>,

    /// Receives unlocked ONyc from OnRe's redemption vault.
    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: validated transitively via the flow PDA seeds.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = outflight_flow.bump,
    )]
    pub outflight_flow: Account<'info, Flow>,

    #[account(
        mut,
        seeds = [REDEMPTION_TRACKER_SEED],
        bump = redemption_tracker.bump,
        close = payer_for_close,
    )]
    pub redemption_tracker: Account<'info, RedemptionTracker>,

    /// CHECK: pinned by `address`; original payer gets rent back.
    #[account(mut, address = redemption_tracker.payer)]
    pub payer_for_close: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
