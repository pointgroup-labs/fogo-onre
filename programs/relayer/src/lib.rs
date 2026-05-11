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

    pub fn send_usdc_to_user<'info>(ctx: Context<'info, SendUsdcToUser<'info>>) -> Result<()> {
        send_usdc_to_user::handler(ctx)
    }

    pub fn swap_usdc_to_onyc<'info>(ctx: Context<'info, SwapUsdcToOnyc<'info>>) -> Result<()> {
        swap_usdc_to_onyc::handler(ctx)
    }

    /// Permissionless: convert outbound flow's ONyc → USDC via any swap
    /// program under NAV-anchored slippage protection. Withdraw fee is
    /// taken in ONyc up front, the post-fee remainder swapped under a
    /// bounded SPL `Approve` to `swap_delegate`. The swap CPI runs under
    /// plain `invoke` — PDA-signer privilege does not propagate. Replaces
    /// the OnRe redemption-request chain (KYC-gated, never executes for
    /// the relayer PDA).
    pub fn swap_onyc_to_usdc<'info>(
        ctx: Context<'info, SwapOnycToUsdc<'info>>,
        swap_ix_data: Vec<u8>,
    ) -> Result<()> {
        swap_onyc_to_usdc::handler(ctx, swap_ix_data)
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
