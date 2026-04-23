//! Withdraw chain, step 3 of 3 (relayer-side step 2 of 2).
//!
//! Replaces the back half of the deleted `swap_onyc_to_usdc`. Pre:
//! `flow.status == RedemptionPending`, OnRe's `redemption_admin` has
//! fulfilled our `RedemptionRequest` (signal: PDA closed). Post:
//! `flow.status == Swapped`, `flow.amount = USDC delta`, singleton tracker
//! closed and rent returned to whoever paid for the request.
//!
//! No CPI is issued here — this is a pure on-chain bookkeeping update on
//! evidence of OnRe's off-chain action. After this, `send_usdc_to_user`
//! works unchanged.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{CONFIG_SEED, FLOW_OUTBOUND_SEED, REDEMPTION_TRACKER_SEED, RELAYER_SEED};
use crate::error::RelayerError;
use crate::events::RedemptionClaimed;
use crate::state::{Flow, FlowStatus, RedemptionTracker, RelayerConfig};

/// Permissionless. Verifies fulfillment, books the USDC delta onto the
/// flow, and closes the singleton.
pub fn handler(ctx: Context<ClaimRedemptionUsdc>) -> Result<()> {
    let flow_key = ctx.accounts.outflight_flow.key();
    let tracker = &ctx.accounts.redemption_tracker;

    // Defense-in-depth — the PDA seed already binds tracker singleton, but
    // explicit check pins the per-flow assertion that `request_redemption_onyc`
    // wrote.
    require_keys_eq!(
        tracker.flow,
        flow_key,
        RelayerError::RedemptionTrackerFlowMismatch
    );

    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::RedemptionPending,
        RelayerError::FlowStatusMismatch
    );

    // Belt-and-braces: the cranker must pass the same PDA we recorded.
    require_keys_eq!(
        ctx.accounts.redemption_request.key(),
        tracker.redemption_request,
        RelayerError::RedemptionRequestMismatch
    );

    // Fulfillment signal from OnRe: `fulfill_redemption_request` closes the
    // `RedemptionRequest` PDA (`close = redemption_admin`). On Solana, a
    // closed account has zero lamports, empty data, and ownership reverts
    // to the system program.
    let req = &ctx.accounts.redemption_request;
    require!(
        req.lamports() == 0 && req.data_is_empty() && req.owner == &system_program::ID,
        RelayerError::RedemptionNotFulfilled
    );

    // USDC arrived at our ATA as part of `fulfill_redemption_request`. Two
    // invariants make this delta exact:
    //   - Singleton mutex (held by `redemption_tracker`'s existence since
    //     the request) blocks any sibling withdraw redemption.
    //   - Deposit-chain instructions (`claim_usdc`, `swap_usdc_to_onyc`) and
    //     the user-outflow (`send_usdc_to_user`) all carry a
    //     `SystemAccount`-typed `redemption_tracker` constraint that fails
    //     while the tracker exists, so no sibling tx can mutate `usdc_ata`
    //     between snapshot and read. The only writer is OnRe.
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

    // `redemption_tracker` is closed by Anchor on instruction return via the
    // `close = payer` constraint below — rent goes back to whoever paid for
    // `request_redemption_onyc`. After return, the singleton seed is free
    // again and a new redemption can be requested.
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimRedemptionUsdc<'info> {
    /// Receives rent from the closed `redemption_tracker`. Need not be the
    /// same key as `tracker.payer` — the close-target is pinned by the
    /// `close = payer_for_close` constraint to `tracker.payer`, see below.
    /// The cranker pays tx fees.
    #[account(mut)]
    pub cranker: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = usdc_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED. Not signing here — no CPI.
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

    /// Singleton, closes to its original payer (recorded in `tracker.payer`).
    /// `tracker.flow == outflight_flow.key()` is verified in the handler.
    #[account(
        mut,
        seeds = [REDEMPTION_TRACKER_SEED],
        bump = redemption_tracker.bump,
        close = payer_for_close,
    )]
    pub redemption_tracker: Account<'info, RedemptionTracker>,

    /// CHECK: pinned by `address = redemption_tracker.payer`. The init-time
    /// payer recorded in the tracker is who gets the rent back.
    #[account(mut, address = redemption_tracker.payer)]
    pub payer_for_close: UncheckedAccount<'info>,

    /// CHECK: must equal `tracker.redemption_request`. The handler verifies
    /// it has been closed by OnRe's `fulfill_redemption_request`.
    pub redemption_request: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
