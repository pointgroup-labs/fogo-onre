#![allow(clippy::diverging_sub_expression)]

use anchor_lang::prelude::*;

pub mod constants;
pub mod cpi;
pub mod error;
pub mod events;
pub mod instructions;
pub mod ntt;
pub mod state;

use instructions::*;

use crate::state::Direction;

declare_id!("onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp");

#[cfg(not(feature = "no-entrypoint"))]
pub mod security {
    use solana_security_txt::security_txt;
    security_txt! {
        name: "FogoOnre",
        project_url: "https://github.com/pointgroup-labs/fogo-onre",
        contacts: "email:info@pointgroup.one",
        policy: "https://github.com/pointgroup-labs/fogo-onre/blob/main/SECURITY.md",
        preferred_languages: "en",
        source_code: "https://github.com/pointgroup-labs/fogo-onre"
    }
}

/// Cross-chain relayer for a configured base/asset token pair over Wormhole
/// NTT. User-facing flows are permissionless; governance is config-gated.
#[program]
pub mod fogo_ntt_relayer {
    use super::*;

    /// One-time deploy bootstrap: create the global config + set the admin.
    pub fn bootstrap(ctx: Context<Bootstrap>) -> Result<()> {
        bootstrap::handler(ctx)
    }

    /// Create a pair's config PDA + relayer-owned ATAs. Admin-gated. NTT
    /// program IDs are init-only safety pins.
    pub fn initialize(
        ctx: Context<Initialize>,
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
        ntt_base_program: Pubkey,
        ntt_asset_program: Pubkey,
        intent_programs: [Pubkey; 2],
    ) -> Result<()> {
        initialize::handler(
            ctx,
            deposit_fee_bps,
            withdraw_fee_bps,
            ntt_base_program,
            ntt_asset_program,
            intent_programs,
        )
    }

    /// Propose a new global admin (step 1 of two-step rotation).
    pub fn set_admin(ctx: Context<SetAdmin>, new_admin: Pubkey) -> Result<()> {
        admin::set_admin(ctx, new_admin)
    }

    /// The pending admin claims the global admin role (step 2).
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        admin::accept_admin(ctx)
    }

    /// Redeem an inbound NTT VAA and create the `Flow` receipt. Direction
    /// selects the token side, NTT manager, and flow seed.
    pub fn receive<'info>(
        ctx: Context<'info, Receive<'info>>,
        direction: Direction,
        redeem_accounts_len: u8,
        min_swap_out: u64,
    ) -> Result<()> {
        instructions::receive::handler(ctx, direction, redeem_accounts_len, min_swap_out)
    }

    /// Route-agnostic outbound send. Routes on `flow.direction`: deposit
    /// pushes asset out, withdraw pushes base out, each via NTT `transfer_lock`
    /// + atomic `release_wormhole_outbound`.
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

    /// Permissionless timeout refund. For a stale `Received` flow, sends the
    /// original token back to `flow.recipient` via NTT, then closes the flow.
    pub fn refund<'info>(ctx: Context<'info, Refund<'info>>, transfer_lock_account_count: u8) -> Result<()> {
        instructions::refund::handler(ctx, transfer_lock_account_count)
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
