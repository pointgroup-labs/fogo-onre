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

use crate::state::Direction;

declare_id!("onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp");

/// Cross-chain relayer: USDC.s on FOGO ↔ ONyc on Solana, both legs over
/// Wormhole NTT. Lets FOGO users hold OnRe's ONyc yield exposure without
/// leaving FOGO.
#[program]
pub mod fogo_onre_relayer {
    use super::*;

    /// One-time setup: config PDA + relayer-authority-owned ATAs.
    pub fn initialize(ctx: Context<Initialize>, deposit_fee_bps: u16, withdraw_fee_bps: u16) -> Result<()> {
        initialize::handler(ctx, deposit_fee_bps, withdraw_fee_bps)
    }

    /// Redeem an inbound NTT VAA (deposit: base/USDC, withdraw: asset/ONyc),
    /// create the `Flow` receipt. Direction selects the NTT manager + flow seed.
    pub fn receive<'info>(
        ctx: Context<'info, Receive<'info>>,
        direction: Direction,
        redeem_accounts_len: u8,
    ) -> Result<()> {
        instructions::receive::handler(ctx, direction, redeem_accounts_len)
    }

    /// Route-agnostic outbound send. Routes on `flow.direction`: deposit
    /// pushes asset (ONyc) out, withdraw pushes base (USDC) out, each via NTT
    /// `transfer_lock` + atomic `release_wormhole_outbound`.
    /// `transfer_lock_account_count` splits `remaining_accounts` between the
    /// two NTT CPIs.
    pub fn send<'info>(ctx: Context<'info, Send<'info>>, transfer_lock_account_count: u8) -> Result<()> {
        instructions::send::handler(ctx, transfer_lock_account_count)
    }

    /// Permissionless, route-agnostic swap. Routes on `flow.direction`:
    /// deposit swaps base→asset (fee from the asset output), withdraw swaps
    /// asset→base (fee from the asset input).
    pub fn swap<'info>(ctx: Context<'info, Swap<'info>>, swap_ix_data: Vec<u8>) -> Result<()> {
        instructions::swap::handler(ctx, swap_ix_data)
    }

    /// Authority-only. `None` args leave fields unchanged. Fee decreases
    /// apply instantly; increases stage for `FEE_TIMELOCK_SLOTS` (~2 days)
    /// then auto-promote on the next `configure` after the window.
    /// `slippage_bps` (capped at `MAX_SLIPPAGE_BPS` via `validate`) applies
    /// immediately to both swap legs' NAV floor.
    pub fn configure(
        ctx: Context<Configure>,
        deposit_fee_bps: Option<u16>,
        withdraw_fee_bps: Option<u16>,
        new_authority: Option<Pubkey>,
        slippage_bps: Option<u16>,
        price_oracle: Option<Pubkey>,
    ) -> Result<()> {
        configure::handler(ctx, deposit_fee_bps, withdraw_fee_bps, new_authority, slippage_bps, price_oracle)
    }

    /// Two-step rotation, step 2. Signer must equal `pending_authority`;
    /// current authority does not sign (lets independent multisigs rotate
    /// without atomic co-sign).
    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        accept_authority::handler(ctx)
    }
}
