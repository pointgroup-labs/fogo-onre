//! Withdraw chain, recovery hatch.
//!
//! Aborts an in-flight OnRe redemption and rolls the flow back to
//! `Claimed`. Used when an OnRe `RedemptionRequest` is stuck — examples
//! include `redemption_admin` outage, OnRe kill-switch activation, the
//! relayer's `usdc_ata` losing its KYC whitelist, or a redemption that
//! sits in `Scheduled` past the operator's tolerance window.
//!
//! ## Why authority-only (not permissionless)
//!
//! Permissionless cancel is a griefing vector: any cranker could call
//! `request_redemption_onyc` → `cancel_redemption_onyc` in a loop, each
//! cycle taking another `withdraw_fee_bps` skim into `fee_vault`. The
//! authority is the existing cold/admin key (same as `sweep`/`configure`)
//! — already trusted to set fees up to 100% — so no new trust surface.
//!
//! ## Post-conditions
//!
//! On success:
//!   - OnRe has returned the locked ONyc (`tracker.onyc_amount_in`) to
//!     the relayer's `onyc_ata` (`redeemer_token_account` in OnRe's
//!     account graph; ATA derivation pins it to `relayer_authority`,
//!     which is the redeemer we passed in `create_redemption_request`).
//!   - `flow.amount = tracker.onyc_amount_in`, `flow.status = Claimed`,
//!     so `request_redemption_onyc` can be retried (with another fee
//!     skim — operator's job to weigh that vs. abandoning the flow).
//!   - Singleton `redemption_tracker` is closed; rent → `tracker.payer`,
//!     freeing the singleton seed for the next redemption.
//!   - The withdraw fee originally taken by `request_redemption_onyc`
//!     is NOT auto-refunded. Operator does off-chain accounting.

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
use crate::state::{Flow, FlowStatus, RedemptionTracker, RelayerConfig};

/// OnRe `cancel_redemption_request` takes no args.
#[derive(AnchorSerialize)]
pub struct OnreCancelRedemptionRequestArgs {}

/// Authority-only. Pre: `flow.status == RedemptionPending`. Post:
/// `flow.status == Claimed`, ONyc returned to `onyc_ata`, singleton closed.
pub fn handler<'info>(ctx: Context<'info, CancelRedemptionOnyc<'info>>) -> Result<()> {
    let flow_key = ctx.accounts.outflight_flow.key();
    let tracker = &ctx.accounts.redemption_tracker;

    // Same per-flow assertion `claim_redemption_usdc` makes — defense in
    // depth on top of the singleton-PDA seed binding.
    require_keys_eq!(
        tracker.flow,
        flow_key,
        RelayerError::RedemptionTrackerFlowMismatch
    );

    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::RedemptionPending,
        RelayerError::FlowStatusMismatch
    );

    // Bounds check — same shape as `request_redemption_onyc`. OnRe's
    // `cancel_redemption_request` `Accounts` struct has 13 entries; we
    // forward verbatim through `remaining_accounts`.
    require!(
        ctx.remaining_accounts.len() > ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX,
        RelayerError::InvalidAccountSplit
    );

    // Pin the redemption_request slot to what the tracker recorded BEFORE
    // firing the CPI. Without this, a malicious authority (yes, even the
    // gated path benefits) could pass a different RedemptionRequest PDA
    // belonging to some unrelated OnRe redemption in slot 2 and cancel
    // *that* one instead. OnRe's seed validation inside the CPI would
    // pass, but the ONyc returned would belong to whoever opened the
    // unrelated request — not us — and `flow.amount` would be silently
    // wrong. We pin equality against `tracker.redemption_request`, which
    // was itself bound to the create-CPI's actual consumed PDA in
    // `request_redemption_onyc` (see binding-fix commit).
    let cpi_redemption_request_key = *ctx.remaining_accounts
        [ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX]
        .key;
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
        &ctx.accounts.relayer_authority.to_account_info(),
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

    // `redemption_tracker` is closed via Anchor's `close = payer_for_close`
    // constraint below; rent → original `request_redemption_onyc` payer.
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

    /// CHECK: PDA derived from RELAYER_SEED. Forced to sign the OnRe CPI
    /// in `invoke_relayer_signed`. Must be the redeemer recorded inside
    /// `redemption_request` (OnRe's cancel constraint enforces this), so
    /// the unlocked ONyc returns to its ATA (`onyc_ata`).
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub onyc_mint: InterfaceAccount<'info, Mint>,

    /// Pinned by `has_one = onyc_mint` and ATA derivation. Receives the
    /// unlocked ONyc back from OnRe's redemption vault. Already exists
    /// (created in `initialize`), so OnRe's `init_if_needed` on the
    /// equivalent slot inside the CPI is a no-op and `signer` (us) does
    /// not actually pay rent.
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

    /// Singleton; closes to its original payer (recorded in `tracker.payer`).
    /// `tracker.flow == outflight_flow.key()` is verified in the handler.
    #[account(
        mut,
        seeds = [REDEMPTION_TRACKER_SEED],
        bump = redemption_tracker.bump,
        close = payer_for_close,
    )]
    pub redemption_tracker: Account<'info, RedemptionTracker>,

    /// CHECK: pinned by `address = redemption_tracker.payer`. The init-time
    /// payer recorded in the tracker is who gets the rent back — same
    /// invariant as `claim_redemption_usdc`'s close path so a cancelled-
    /// then-reclaimed flow never has rent diverted.
    #[account(mut, address = redemption_tracker.payer)]
    pub payer_for_close: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
