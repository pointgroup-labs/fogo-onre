use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, NTT_ONYC_PROGRAM_ID, NTT_REDEEM_IX,
    NTT_RELEASE_INBOUND_UNLOCK_IX, RELAYER_SEED,
};
use crate::cpi::invoke_relayer_signed;
use crate::error::RelayerError;
use crate::events::OnycUnlocked;
use crate::ntt::{
    parse_fogo_sender_from_vtm, validate_ntt_redeem_release_accounts, NttRedeemArgs,
    NttReleaseInboundArgs,
};
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// Release ONyc from NTT custody for an inbound VAA from FOGO and create
/// the outbound `Flow` receipt for the eventual USDC return.
/// Permissionless; NTT redeem validates guardian sigs.
///
/// `remaining_accounts` = redeem ++ release; `redeem_accounts_len` splits.
pub fn handler<'info>(
    ctx: Context<'info, UnlockOnyc<'info>>,
    redeem_accounts_len: u8,
) -> Result<()> {
    let fogo_sender = parse_fogo_sender_from_vtm(&ctx.accounts.ntt_transceiver_message)?;

    let split = redeem_accounts_len as usize;
    let total = ctx.remaining_accounts.len();
    require!(
        split > 0 && split < total,
        RelayerError::InvalidAccountSplit
    );
    let (redeem_accs, release_accs) = ctx.remaining_accounts.split_at(split);

    validate_ntt_redeem_release_accounts(
        redeem_accs,
        release_accs,
        &NTT_ONYC_PROGRAM_ID,
        ctx.accounts.ntt_transceiver_message.key(),
        ctx.accounts.ntt_inbox_item.key(),
        ctx.accounts.onyc_ata.key(),
    )?;

    let bump = ctx.accounts.relayer_config.relayer_authority_bump;
    let authority = ctx.accounts.relayer_authority.to_account_info();

    let pre_balance = ctx.accounts.onyc_ata.amount;

    invoke_relayer_signed(
        NTT_ONYC_PROGRAM_ID,
        &NTT_REDEEM_IX,
        &NttRedeemArgs {},
        redeem_accs,
        Some(&authority),
        bump,
    )?;

    invoke_relayer_signed(
        NTT_ONYC_PROGRAM_ID,
        &NTT_RELEASE_INBOUND_UNLOCK_IX,
        &NttReleaseInboundArgs {
            revert_on_delay: false,
        },
        release_accs,
        Some(&authority),
        bump,
    )?;

    ctx.accounts.onyc_ata.reload()?;
    let amount = ctx
        .accounts
        .onyc_ata
        .amount
        .checked_sub(pre_balance)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    let flow_key = ctx.accounts.outflight_flow.key();

    let flow = &mut ctx.accounts.outflight_flow;
    flow.fogo_sender = fogo_sender;
    flow.status = FlowStatus::Claimed;
    flow.amount = amount;
    flow.payer = ctx.accounts.payer.key();
    flow.bump = ctx.bumps.outflight_flow;

    emit!(OnycUnlocked {
        flow: flow_key,
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        fogo_sender,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UnlockOnyc<'info> {
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

    /// CHECK: validated by NTT CPI; seeds the flow PDA.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    /// CHECK: owner pin + discriminator/offset checks in handler.
    #[account(owner = NTT_ONYC_PROGRAM_ID)]
    pub ntt_transceiver_message: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Flow::INIT_SPACE,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump,
    )]
    pub outflight_flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
