//! Timeout refund: returns the original received token when a `Received` flow
//! cannot clear. Refunds go only to `flow.recipient`, never swap, and close the
//! flow so the same funds cannot be spent twice.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::{
        FOGO_WORMHOLE_CHAIN_ID, NTT_RELEASE_WORMHOLE_OUTBOUND_IX, NTT_TRANSFER_LOCK_IX, REFUND_TIMEOUT_SLOTS,
        RELAYER_SEED,
    },
    cpi::{approve_ntt_session_authority, invoke_relayer_signed},
    error::RelayerError,
    events::Refunded,
    ntt::{NttReleaseOutboundArgs, NttTransferArgs, derive_session_authority},
    state::{Direction, Flow, FlowStatus, PairConfig},
};

pub fn handler<'info>(ctx: Context<'info, Refund<'info>>, transfer_lock_account_count: u8) -> Result<()> {
    let direction = ctx.accounts.flow.direction;
    require!(ctx.accounts.flow.status == FlowStatus::Received, RelayerError::FlowStatusMismatch);

    let ready_slot =
        ctx.accounts.flow.received_slot.checked_add(REFUND_TIMEOUT_SLOTS).ok_or(RelayerError::ArithmeticOverflow)?;
    require!(Clock::get()?.slot >= ready_slot, RelayerError::RefundTooEarly);

    let amount = ctx.accounts.flow.amount;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    let recipient = ctx.accounts.flow.recipient;

    let ntt_program = ctx.accounts.pair_config.receive_ntt_program(direction);
    let from_ata = match direction {
        Direction::Deposit => ctx.accounts.base_ata.to_account_info(),
        Direction::Withdraw => ctx.accounts.asset_ata.to_account_info(),
    };

    let transfer_args = NttTransferArgs {
        amount,
        recipient_chain: FOGO_WORMHOLE_CHAIN_ID,
        recipient_address: recipient.to_bytes(),
        should_queue: false,
    };

    let (session_authority, _) =
        derive_session_authority(&ntt_program, &ctx.accounts.relayer_authority.key(), &transfer_args);

    let bump = ctx.accounts.pair_config.relayer_authority_bump;

    approve_ntt_session_authority(
        &ctx.accounts.token_program.to_account_info(),
        &from_ata,
        &ctx.accounts.relayer_authority.to_account_info(),
        bump,
        session_authority,
        ctx.remaining_accounts,
        amount,
    )?;

    let split = transfer_lock_account_count as usize;
    require!(ctx.remaining_accounts.len() > split, RelayerError::InvalidAccountSplit);
    let (transfer_lock_accs, release_accs) = ctx.remaining_accounts.split_at(split);

    let authority = ctx.accounts.relayer_authority.to_account_info();

    invoke_relayer_signed(
        ntt_program,
        &NTT_TRANSFER_LOCK_IX,
        &transfer_args,
        transfer_lock_accs,
        Some(&authority),
        bump,
    )?;
    invoke_relayer_signed(
        ntt_program,
        &NTT_RELEASE_WORMHOLE_OUTBOUND_IX,
        &NttReleaseOutboundArgs { revert_on_delay: false },
        release_accs,
        None,
        bump,
    )?;

    emit!(Refunded {
        flow: ctx.accounts.flow.key(),
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        recipient,
        direction,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [PairConfig::SEED, base_mint.key().as_ref(), asset_mint.key().as_ref()],
        bump = pair_config.bump,
        has_one = base_mint,
        has_one = asset_mint,
    )]
    pub pair_config: Box<Account<'info, PairConfig>>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = pair_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    pub asset_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub base_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = asset_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub asset_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: seed material only; validated transitively via the flow PDA.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        close = rent_destination,
        seeds = [Flow::seed(flow.direction), pair_config.key().as_ref(), ntt_inbox_item.key().as_ref()],
        bump = flow.bump,
    )]
    pub flow: Box<Account<'info, Flow>>,

    /// CHECK: pinned to the flow PDA's stored `payer`; receives rent refund.
    #[account(mut, address = flow.payer)]
    pub rent_destination: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
