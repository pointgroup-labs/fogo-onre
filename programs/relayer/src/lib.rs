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
pub mod vaa;

use instructions::*;

declare_id!("Re1ayRHhmeqByGjgT5uLFExZCvQ8sv6LK74xowK8pJH");

/// Stateless cross-chain relayer between FOGO and Solana (Phase 1 — no vault).
///
/// All operational instructions are permissionless. Safety comes from the
/// Flow PDA design: each inbound Wormhole message carries the originating
/// FOGO user's wallet in its payload. `claim_usdc` / `unlock_onyc` persist
/// that wallet in a one-shot `Flow` PDA keyed by the bridge's per-VAA claim
/// account; `lock_onyc` / `send_usdc_to_user` consume the PDA to choose the
/// outbound recipient. A stolen operator key cannot redirect outbound
/// transfers — the claim PDA is CPI-created by the bridge program and
/// unforgeable.
#[program]
pub mod relayer {
    use super::*;

    /// One-time setup: create config PDA + relayer-authority-owned ATAs.
    pub fn initialize(
        ctx: Context<Initialize>,
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
    ) -> Result<()> {
        initialize::handler(ctx, deposit_fee_bps, withdraw_fee_bps)
    }

    // Deposit leg: FOGO user → Solana → back to FOGO user.

    /// Claim bridged USDC and create an inflight `Flow` receipt binding the
    /// eventual bONyc return to the originator's FOGO wallet.
    pub fn claim_usdc<'info>(ctx: Context<'info, ClaimUsdc<'info>>) -> Result<()> {
        claim_usdc::handler(ctx)
    }

    pub fn swap_usdc_to_onyc<'info>(ctx: Context<'info, SwapUsdcToOnyc<'info>>) -> Result<()> {
        swap_usdc_to_onyc::handler(ctx)
    }

    /// Lock ONyc via NTT, sending bONyc to `flow.fogo_sender`. Closes the PDA.
    pub fn lock_onyc<'info>(ctx: Context<'info, LockOnyc<'info>>) -> Result<()> {
        lock_onyc::handler(ctx)
    }

    // Withdrawal leg.

    /// Release ONyc from NTT custody and record a `Flow` receipt for the
    /// withdrawal initiator.
    pub fn unlock_onyc<'info>(
        ctx: Context<'info, UnlockOnyc<'info>>,
        redeem_accounts_len: u8,
    ) -> Result<()> {
        unlock_onyc::handler(ctx, redeem_accounts_len)
    }

    pub fn swap_onyc_to_usdc<'info>(ctx: Context<'info, SwapOnycToUsdc<'info>>) -> Result<()> {
        swap_onyc_to_usdc::handler(ctx)
    }

    /// Send USDC to `flow.fogo_sender` and close the PDA.
    pub fn send_usdc_to_user<'info>(ctx: Context<'info, SendUsdcToUser<'info>>) -> Result<()> {
        send_usdc_to_user::handler(ctx)
    }

    // Admin.

    /// Authority-only. `None` args leave the corresponding field unchanged.
    /// `new_authority`: `Some(pk)` proposes; `Some(default())` cancels;
    /// `None` leaves the proposal slot alone. Acceptance happens in
    /// `accept_authority`.
    pub fn configure(
        ctx: Context<Configure>,
        deposit_fee_bps: Option<u16>,
        withdraw_fee_bps: Option<u16>,
        new_authority: Option<Pubkey>,
    ) -> Result<()> {
        configure::handler(ctx, deposit_fee_bps, withdraw_fee_bps, new_authority)
    }

    /// Two-step rotation, step two. Signer must equal
    /// `relayer_config.pending_authority`. The current authority does NOT
    /// participate — by design, so two independent multisigs can rotate
    /// without atomic cross-multisig coordination.
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        accept_authority::handler(ctx)
    }

    /// Authority-only escape hatch for stranded balances on the
    /// PDA-owned ATAs (commingled fees, dust, accidental transfers).
    /// See `sweep.rs` for the trust-model rationale.
    pub fn sweep(ctx: Context<Sweep>, amount: u64) -> Result<()> {
        sweep::handler(ctx, amount)
    }
}
