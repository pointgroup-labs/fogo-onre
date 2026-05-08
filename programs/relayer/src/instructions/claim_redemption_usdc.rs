//! Withdraw chain, step 3 of 3. Pure on-chain bookkeeping (no CPI):
//! verifies OnRe fulfilled the request (signal: PDA closed), books the
//! USDC delta onto the flow, closes the singleton tracker.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{CONFIG_SEED, FLOW_OUTBOUND_SEED, REDEMPTION_TRACKER_SEED, RELAYER_SEED};
use crate::error::RelayerError;
use crate::events::RedemptionClaimed;
use crate::state::{Flow, FlowStatus, RedemptionTracker, RelayerConfig};

/// Permissionless. Verifies fulfillment, books USDC delta, closes singleton.
pub fn handler(ctx: Context<ClaimRedemptionUsdc>) -> Result<()> {
    let flow_key = ctx.accounts.outflight_flow.key();
    let tracker = &ctx.accounts.redemption_tracker;

    require_keys_eq!(
        tracker.flow,
        flow_key,
        RelayerError::RedemptionTrackerFlowMismatch
    );

    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::RedemptionPending,
        RelayerError::FlowStatusMismatch
    );

    require_keys_eq!(
        ctx.accounts.redemption_request.key(),
        tracker.redemption_request,
        RelayerError::RedemptionRequestMismatch
    );

    // Fulfillment signal: OnRe's `fulfill_redemption_request` closes the
    // PDA — zero lamports, empty data, owner reverts to system program.
    let req = &ctx.accounts.redemption_request;
    require!(
        req.lamports() == 0 && req.data_is_empty() && req.owner == &system_program::ID,
        RelayerError::RedemptionNotFulfilled
    );

    // Singleton mutex + sibling gates ensure OnRe is the only writer to
    // `usdc_ata` between snapshot and read — delta is exact.
    ctx.accounts.usdc_ata.reload()?;
    let delta = ctx
        .accounts
        .usdc_ata
        .amount
        .checked_sub(tracker.usdc_ata_pre_balance)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(delta > 0, RelayerError::ZeroAmountFlow);

    let onyc_amount_in = tracker.onyc_amount_in;
    let redemption_request = tracker.redemption_request;

    let flow = &mut ctx.accounts.outflight_flow;
    flow.amount = delta;
    flow.status = FlowStatus::Swapped;

    emit!(RedemptionClaimed {
        flow: flow_key,
        redemption_request,
        onyc_amount_in,
        usdc_received: delta,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRedemptionUsdc<'info> {
    /// Receives rent from closed `redemption_tracker`. Need not equal
    /// `tracker.payer` — close-target is `payer_for_close` below.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = usdc_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: InterfaceAccount<'info, TokenAccount>,

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

    /// CHECK: pinned by `address = redemption_tracker.payer`.
    #[account(mut, address = redemption_tracker.payer)]
    pub payer_for_close: UncheckedAccount<'info>,

    /// CHECK: must equal `tracker.redemption_request`; handler verifies
    /// it has been closed by OnRe.
    pub redemption_request: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
