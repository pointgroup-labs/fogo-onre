#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod error;
pub mod events;
pub mod instructions;
pub mod ntt;
pub mod onre;
pub mod state;

use instructions::*;

declare_id!("onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp");

/// On-chain relayer for OnRe's cross-chain yield product.
///
/// OnRe issues ONyc, a tokenized reinsurance position on Solana. This
/// program lets FOGO users hold that yield exposure without leaving
/// FOGO: USDC.s on FOGO ↔ ONyc on Solana, both legs over Wormhole NTT.
#[program]
pub mod fogo_onre_relayer {
    use super::*;

    /// One-time setup: create config PDA + relayer-authority-owned ATAs.
    pub fn initialize(
        ctx: Context<Initialize>,
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
    ) -> Result<()> {
        initialize::handler(ctx, deposit_fee_bps, withdraw_fee_bps)
    }

    /// Redeem bridged USDC.s from FOGO via NTT and create an inflight `Flow`
    /// receipt binding the eventual ONyc return to the originator's FOGO
    /// wallet.
    pub fn claim_usdc<'info>(
        ctx: Context<'info, ClaimUsdc<'info>>,
        redeem_accounts_len: u8,
    ) -> Result<()> {
        claim_usdc::handler(ctx, redeem_accounts_len)
    }

    pub fn swap_usdc_to_onyc<'info>(ctx: Context<'info, SwapUsdcToOnyc<'info>>) -> Result<()> {
        swap_usdc_to_onyc::handler(ctx)
    }

    /// Lock ONyc via NTT and atomically publish the outbound Wormhole VAA,
    /// sending ONyc to `flow.fogo_sender`. Closes the PDA.
    ///
    /// `transfer_lock_account_count` is the boundary index in
    /// `remaining_accounts` between the `transfer_lock` (14 entries) and
    /// `release_wormhole_outbound` (15 entries) account lists.
    pub fn lock_onyc<'info>(
        ctx: Context<'info, LockOnyc<'info>>,
        transfer_lock_account_count: u8,
    ) -> Result<()> {
        lock_onyc::handler(ctx, transfer_lock_account_count)
    }

    /// Release ONyc from NTT custody and record a `Flow` receipt for the
    /// withdrawal initiator.
    pub fn unlock_onyc<'info>(
        ctx: Context<'info, UnlockOnyc<'info>>,
        redeem_accounts_len: u8,
    ) -> Result<()> {
        unlock_onyc::handler(ctx, redeem_accounts_len)
    }

    /// Forward flow's ONyc to OnRe via `create_redemption_request` and
    /// init the singleton tracker. Fee taken pre-CPI.
    pub fn request_redemption_onyc<'info>(
        ctx: Context<'info, RequestRedemptionOnyc<'info>>,
    ) -> Result<()> {
        request_redemption_onyc::handler(ctx)
    }

    pub fn claim_redemption_usdc(ctx: Context<ClaimRedemptionUsdc>) -> Result<()> {
        claim_redemption_usdc::handler(ctx)
    }

    /// Authority-only escape hatch. Aborts an in-flight OnRe redemption
    /// (returns ONyc to `onyc_ata`, rolls flow back to `Claimed`, frees
    /// the singleton). Authority-gated to prevent the
    /// request→cancel→request fee-griefing loop a permissionless cancel
    /// would enable.
    pub fn cancel_redemption_onyc<'info>(
        ctx: Context<'info, CancelRedemptionOnyc<'info>>,
    ) -> Result<()> {
        cancel_redemption_onyc::handler(ctx)
    }

    pub fn send_usdc_to_user<'info>(ctx: Context<'info, SendUsdcToUser<'info>>) -> Result<()> {
        send_usdc_to_user::handler(ctx)
    }

    /// Authority-only. `None` args leave the corresponding field unchanged.
    /// Fee decreases apply instantly; increases stage into `pending_fee`
    /// for `FEE_TIMELOCK_SLOTS` (~2 days), auto-promoted on the next
    /// `configure` call after the window elapses.
    pub fn configure(
        ctx: Context<Configure>,
        deposit_fee_bps: Option<u16>,
        withdraw_fee_bps: Option<u16>,
        new_authority: Option<Pubkey>,
    ) -> Result<()> {
        configure::handler(ctx, deposit_fee_bps, withdraw_fee_bps, new_authority)
    }

    /// Two-step rotation, step two. Signer must equal
    /// `relayer_config.pending_authority`. Current authority does NOT
    /// participate — by design, so two independent multisigs can rotate
    /// without atomic cross-multisig coordination.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        accept_authority::handler(ctx)
    }
}
