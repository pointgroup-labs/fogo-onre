use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, FOGO_WORMHOLE_CHAIN_ID, NTT_RELEASE_WORMHOLE_OUTBOUND_IX,
    NTT_TRANSFER_LOCK_IX, NTT_USDC_PROGRAM_ID, RELAYER_SEED,
};
use crate::cpi::{approve_ntt_session_authority, invoke_relayer_signed};
use crate::error::RelayerError;
use crate::events::Sent;
use crate::ntt::{derive_session_authority, NttReleaseOutboundArgs, NttTransferArgs};
use crate::state::{Direction, Flow, FlowStatus, RelayerConfig};

/// Lock USDC via NTT and atomically publish the outbound VAA to
/// `flow.recipient`. Permissionless; PDA close returns rent and
/// blocks replay.
///
/// `transfer_lock_account_count` partitions `remaining_accounts`:
///   `[..N]` → NTT `transfer_lock`
///   `[N..]` → NTT `release_wormhole_outbound` (atomic VAA emission;
///             without it the OutboxItem queues without a VAA and the
///             user's USDC.s never lands on FOGO — mirrors
///             `lock_onyc.rs`'s atomic-emission pattern).
pub fn handler<'info>(
    ctx: Context<'info, SendUsdcToUser<'info>>,
    transfer_lock_account_count: u8,
) -> Result<()> {
    let flow = &mut ctx.accounts.outflight_flow;
    require!(
        flow.status == FlowStatus::Swapped,
        RelayerError::FlowStatusMismatch
    );

    let amount = flow.amount;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    let recipient = flow.recipient;

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
        &ctx.accounts.base_ata.to_account_info(),
        &ctx.accounts.relayer_authority.to_account_info(),
        bump,
        session_authority,
        ctx.remaining_accounts,
        amount,
    )?;

    let authority = ctx.accounts.relayer_authority.to_account_info();

    // Split AFTER pre-CPI checks so failure-path tests with stub
    // remaining_accounts trip those errors first. Mirrors lock_onyc.rs.
    let split = transfer_lock_account_count as usize;
    require!(
        ctx.remaining_accounts.len() > split,
        RelayerError::InvalidAccountSplit,
    );
    let (transfer_lock_accs, release_accs) = ctx.remaining_accounts.split_at(split);

    invoke_relayer_signed(
        NTT_USDC_PROGRAM_ID,
        &NTT_TRANSFER_LOCK_IX,
        &transfer_args,
        transfer_lock_accs,
        Some(&authority),
        bump,
    )?;

    // Atomic VAA emission. Without this the OutboxItem queues without
    // a Wormhole message, leaving the user's USDC stranded in NTT
    // custody on Solana with no VAA for FOGO to redeem against.
    // Passthrough: release CPI doesn't reserve a relayer-authority signer slot.
    invoke_relayer_signed(
        NTT_USDC_PROGRAM_ID,
        &NTT_RELEASE_WORMHOLE_OUTBOUND_IX,
        &NttReleaseOutboundArgs {
            revert_on_delay: false,
        },
        release_accs,
        None,
        bump,
    )?;

    emit!(Sent {
        flow: ctx.accounts.outflight_flow.key(),
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        recipient,
        direction: Direction::Withdraw,
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
        has_one = base_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub base_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub base_ata: InterfaceAccount<'info, TokenAccount>,

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

    pub token_program: Interface<'info, TokenInterface>,
}
