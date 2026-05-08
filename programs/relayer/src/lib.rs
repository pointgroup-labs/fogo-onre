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

/// Cross-chain relayer: USDC.s on FOGO ↔ ONyc on Solana, both legs over
/// Wormhole NTT. Lets FOGO users hold OnRe's ONyc yield exposure without
/// leaving FOGO.
#[program]
pub mod fogo_onre_relayer {
    use super::*;

    /// One-time setup: config PDA + relayer-authority-owned ATAs.
    pub fn initialize(
        ctx: Context<Initialize>,
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
    ) -> Result<()> {
        initialize::handler(ctx, deposit_fee_bps, withdraw_fee_bps)
    }

    /// Redeem inbound USDC.s VAA, create inbound `Flow` receipt.
    pub fn claim_usdc<'info>(
        ctx: Context<'info, ClaimUsdc<'info>>,
        redeem_accounts_len: u8,
    ) -> Result<()> {
        claim_usdc::handler(ctx, redeem_accounts_len)
    }

    pub fn swap_usdc_to_onyc<'info>(ctx: Context<'info, SwapUsdcToOnyc<'info>>) -> Result<()> {
        swap_usdc_to_onyc::handler(ctx)
    }

    /// Lock ONyc via NTT and atomically emit the outbound VAA.
    /// `transfer_lock_account_count` splits `remaining_accounts` between
    /// `transfer_lock` and `release_wormhole_outbound`.
    pub fn lock_onyc<'info>(
        ctx: Context<'info, LockOnyc<'info>>,
        transfer_lock_account_count: u8,
    ) -> Result<()> {
        lock_onyc::handler(ctx, transfer_lock_account_count)
    }

    /// Release ONyc from NTT custody, create outbound `Flow` receipt.
    pub fn unlock_onyc<'info>(
        ctx: Context<'info, UnlockOnyc<'info>>,
        redeem_accounts_len: u8,
    ) -> Result<()> {
        unlock_onyc::handler(ctx, redeem_accounts_len)
    }

    /// Forward flow's ONyc to OnRe + init singleton tracker; fee taken pre-CPI.
    pub fn request_redemption_onyc<'info>(
        ctx: Context<'info, RequestRedemptionOnyc<'info>>,
    ) -> Result<()> {
        request_redemption_onyc::handler(ctx)
    }

    pub fn claim_redemption_usdc(ctx: Context<ClaimRedemptionUsdc>) -> Result<()> {
        claim_redemption_usdc::handler(ctx)
    }

    /// Authority-only escape hatch — rolls a stuck redemption back to
    /// `Claimed` and frees the singleton. Authority-gated to prevent a
    /// request→cancel fee-griefing loop.
    pub fn cancel_redemption_onyc<'info>(
        ctx: Context<'info, CancelRedemptionOnyc<'info>>,
    ) -> Result<()> {
        cancel_redemption_onyc::handler(ctx)
    }

    pub fn send_usdc_to_user<'info>(ctx: Context<'info, SendUsdcToUser<'info>>) -> Result<()> {
        send_usdc_to_user::handler(ctx)
    }

    /// Authority-only. `None` args leave fields unchanged. Fee decreases
    /// apply instantly; increases stage for `FEE_TIMELOCK_SLOTS` (~2 days)
    /// then auto-promote on the next `configure` after the window.
    pub fn configure(
        ctx: Context<Configure>,
        deposit_fee_bps: Option<u16>,
        withdraw_fee_bps: Option<u16>,
        new_authority: Option<Pubkey>,
    ) -> Result<()> {
        configure::handler(ctx, deposit_fee_bps, withdraw_fee_bps, new_authority)
    }

    /// Two-step rotation, step 2. Signer must equal `pending_authority`;
    /// current authority does not sign (lets independent multisigs rotate
    /// without atomic co-sign).
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        accept_authority::handler(ctx)
    }
}
