use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_INBOUND_SEED, FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID,
    NTT_RELEASE_WORMHOLE_OUTBOUND_IX, NTT_TRANSFER_LOCK_IX, RELAYER_SEED,
    SPL_TOKEN_APPROVE_IX_TAG,
};
use crate::cpi::{invoke_relayer_passthrough_signed, invoke_relayer_signed};
use crate::error::RelayerError;
use crate::events::OnycLocked;
use crate::ntt::{derive_session_authority, NttReleaseOutboundArgs, NttTransferArgs};
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// Lock the flow's ONyc via Wormhole NTT and atomically publish the
/// outbound Wormhole VAA, sending ONyc back to `flow.fogo_sender`.
/// Permissionless; closing the PDA returns rent and blocks replay.
///
/// `transfer_lock_account_count` partitions `remaining_accounts` between
/// the two CPIs:
///
///   `remaining_accounts[..N]` → NTT `transfer_lock` (14 entries)
///   `remaining_accounts[N..]` → NTT `release_wormhole_outbound` (15 entries)
///
/// Without the merged release, the OutboxItem would queue without a VAA
/// and a separate `release_wormhole_outbound` would be needed — see the
/// rationale in the SDK builder docstring.
pub fn handler<'info>(
    ctx: Context<'info, LockOnyc<'info>>,
    transfer_lock_account_count: u8,
) -> Result<()> {
    let flow = &mut ctx.accounts.inflight_flow;
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
        &NTT_ONYC_PROGRAM_ID,
        &ctx.accounts.relayer_authority.key(),
        &transfer_args,
    );

    let bump = [ctx.accounts.relayer_config.relayer_authority_bump];
    let signer_seeds: &[&[u8]] = &[RELAYER_SEED, &bump];

    let approve_ix = instruction::Instruction {
        program_id: ctx.accounts.token_program.key(),
        accounts: vec![
            AccountMeta::new(ctx.accounts.onyc_ata.key(), false),
            AccountMeta::new_readonly(session_authority, false),
            AccountMeta::new_readonly(ctx.accounts.relayer_authority.key(), true),
        ],
        data: {
            let mut d = Vec::with_capacity(9);
            d.push(SPL_TOKEN_APPROVE_IX_TAG);
            d.extend_from_slice(&amount.to_le_bytes());
            d
        },
    };

    let session_auth_info = ctx
        .remaining_accounts
        .iter()
        .find(|a| a.key() == session_authority)
        .ok_or(RelayerError::MissingSessionAuthority)?;

    invoke_signed(
        &approve_ix,
        &[
            ctx.accounts.onyc_ata.to_account_info(),
            session_auth_info.to_account_info(),
            ctx.accounts.relayer_authority.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    // Split AFTER the pre-CPI checks above (status / amount / session-auth
    // lookup) so failure-path tests that supply a stub remaining_accounts
    // still trip those errors first.
    let split = transfer_lock_account_count as usize;
    require!(
        ctx.remaining_accounts.len() > split,
        RelayerError::InvalidAccountSplit,
    );
    let (transfer_lock_accs, release_accs) = ctx.remaining_accounts.split_at(split);

    invoke_relayer_signed(
        NTT_ONYC_PROGRAM_ID,
        &NTT_TRANSFER_LOCK_IX,
        &transfer_args,
        transfer_lock_accs,
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
    )?;

    // Atomic VAA emission. NTT v3 splits queue (`transfer_lock`) from
    // attestation (`release_wormhole_outbound`) — running both in one ix
    // means every successful `lock_onyc` emits a Wormhole message,
    // closing the "OutboxItem queued but never released" failure mode.
    invoke_relayer_passthrough_signed(
        NTT_ONYC_PROGRAM_ID,
        &NTT_RELEASE_WORMHOLE_OUTBOUND_IX,
        &NttReleaseOutboundArgs { revert_on_delay: false },
        release_accs,
        ctx.accounts.relayer_config.relayer_authority_bump,
    )?;

    emit!(OnycLocked {
        flow: ctx.accounts.inflight_flow.key(),
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        fogo_sender: recipient,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct LockOnyc<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = onyc_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub onyc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: seed material only; validated transitively via the flow PDA.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        close = rent_destination,
        seeds = [FLOW_INBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = inflight_flow.bump,
    )]
    pub inflight_flow: Account<'info, Flow>,

    /// CHECK: pinned to the flow PDA's stored `payer`; receives rent refund.
    #[account(mut, address = inflight_flow.payer)]
    pub rent_destination: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
