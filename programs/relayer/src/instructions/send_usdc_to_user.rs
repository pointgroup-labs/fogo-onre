use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, FOGO_WORMHOLE_CHAIN_ID, NTT_TRANSFER_LOCK_IX,
    NTT_USDC_PROGRAM_ID, REDEMPTION_TRACKER_SEED, RELAYER_SEED,
};
use crate::cpi::{approve_ntt_session_authority, invoke_relayer_signed};
use crate::error::RelayerError;
use crate::events::UsdcSentToUser;
use crate::ntt::{derive_session_authority, NttTransferArgs};
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// Lock USDC via NTT, sending USDC.s back to `flow.fogo_sender`.
/// Permissionless; PDA close returns rent and blocks replay.
pub fn handler<'info>(ctx: Context<'info, SendUsdcToUser<'info>>) -> Result<()> {
    let flow = &mut ctx.accounts.outflight_flow;
    require!(
        flow.status == FlowStatus::Swapped,
        RelayerError::FlowStatusMismatch
    );

    let amount = flow.amount;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    let recipient = flow.fogo_sender;

    let transfer_args = NttTransferArgs {
        amount,
        recipient_chain: FOGO_WORMHOLE_CHAIN_ID,
        recipient_address: recipient,
        should_queue: false,
    };

    // NTT binds session-authority to a hash of the transfer args.
    let (session_authority, _) = derive_session_authority(
        &NTT_USDC_PROGRAM_ID,
        &ctx.accounts.relayer_authority.key(),
        &transfer_args,
    );

    let bump = ctx.accounts.relayer_config.relayer_authority_bump;

    approve_ntt_session_authority(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.usdc_ata.to_account_info(),
        &ctx.accounts.relayer_authority.to_account_info(),
        bump,
        session_authority,
        ctx.remaining_accounts,
        amount,
    )?;

    let authority = ctx.accounts.relayer_authority.to_account_info();
    invoke_relayer_signed(
        NTT_USDC_PROGRAM_ID,
        &NTT_TRANSFER_LOCK_IX,
        &transfer_args,
        ctx.remaining_accounts,
        Some(&authority),
        bump,
    )?;

    emit!(UsdcSentToUser {
        flow: ctx.accounts.outflight_flow.key(),
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        fogo_sender: recipient,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SendUsdcToUser<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

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
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: seed material only; validated transitively via the flow PDA.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        close = rent_destination,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = outflight_flow.bump,
    )]
    pub outflight_flow: Account<'info, Flow>,

    /// CHECK: pinned to the flow PDA's stored `payer`; receives rent refund.
    #[account(mut, address = outflight_flow.payer)]
    pub rent_destination: UncheckedAccount<'info>,

    /// Singleton mutex gate — a concurrent outflow during an in-flight
    /// redemption would poison the pre-balance delta. Stuck redemptions
    /// are recovered via `cancel_redemption_onyc`.
    #[account(
        seeds = [REDEMPTION_TRACKER_SEED],
        bump,
    )]
    pub redemption_tracker: SystemAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
