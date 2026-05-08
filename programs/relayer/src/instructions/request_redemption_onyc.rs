use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, ONRE_CREATE_REDEMPTION_REQUEST_IX,
    ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX, ONRE_PROGRAM_ID,
    REDEMPTION_TRACKER_SEED, RELAYER_SEED,
};
use crate::cpi::{invoke_relayer_signed, relayer_signed_transfer_checked};
use crate::error::RelayerError;
use crate::events::RedemptionRequested;
use crate::onre::OnreCreateRedemptionRequestArgs;
use crate::state::{Flow, FlowStatus, RedemptionTracker, RelayerConfig};

pub fn handler<'info>(ctx: Context<'info, RequestRedemptionOnyc<'info>>) -> Result<()> {
    let flow_key = ctx.accounts.outflight_flow.key();
    let gross = ctx.accounts.outflight_flow.amount;

    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::Claimed,
        RelayerError::FlowStatusMismatch
    );
    require!(gross > 0, RelayerError::ZeroAmountFlow);

    // `configure`'s asymmetric timelock protects against retroactive raises.
    let (net, fee) = ctx.accounts.relayer_config.apply_withdraw_fee(gross)?;

    // Pre-snapshot guards against a cranker substituting their own
    // pubkey at OnRe's `redeemer` slot — the post-CPI delta check
    // would revert (incl. tracker init), so the singleton mutex is
    // never left wedged.
    ctx.accounts.onyc_ata.reload()?;
    let onyc_pre_total = ctx.accounts.onyc_ata.amount;
    require!(onyc_pre_total >= gross, RelayerError::BalanceUnderflow);

    relayer_signed_transfer_checked(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.onyc_ata.to_account_info(),
        &ctx.accounts.onyc_mint.to_account_info(),
        &ctx.accounts.fee_vault.to_account_info(),
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
        fee,
        ctx.accounts.onyc_mint.decimals,
    )?;

    // Singleton mutex makes OnRe the only writer to `usdc_ata` between
    // snapshot and post-fulfill read.
    ctx.accounts.usdc_ata.reload()?;
    let usdc_pre = ctx.accounts.usdc_ata.amount;

    require!(
        ctx.remaining_accounts.len() > ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX,
        RelayerError::InvalidAccountSplit
    );

    invoke_relayer_signed(
        ONRE_PROGRAM_ID,
        &ONRE_CREATE_REDEMPTION_REQUEST_IX,
        &OnreCreateRedemptionRequestArgs { amount: net },
        ctx.remaining_accounts,
        Some(&ctx.accounts.relayer_authority.to_account_info()),
        ctx.accounts.relayer_config.relayer_authority_bump,
    )?;

    // Enforce role-slot invariant.
    ctx.accounts.onyc_ata.reload()?;
    let onyc_consumed = onyc_pre_total
        .checked_sub(ctx.accounts.onyc_ata.amount)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(
        onyc_consumed == gross,
        RelayerError::UnexpectedOnycConsumed
    );

    // OnRe's `init` seed-validated this key; successful CPI proves it.
    let redemption_request_key =
        *ctx.remaining_accounts[ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX].key;

    let tracker = &mut ctx.accounts.redemption_tracker;
    tracker.flow = flow_key;
    tracker.redemption_request = redemption_request_key;
    tracker.usdc_ata_pre_balance = usdc_pre;
    tracker.onyc_amount_in = net;
    tracker.payer = ctx.accounts.payer.key();
    tracker.bump = ctx.bumps.redemption_tracker;

    let flow = &mut ctx.accounts.outflight_flow;
    flow.amount = net;
    flow.status = FlowStatus::RedemptionPending;

    emit!(RedemptionRequested {
        flow: flow_key,
        redemption_request: tracker.redemption_request,
        gross_amount: gross,
        fee_amount: fee,
        net_amount: net,
        usdc_ata_pre_balance: usdc_pre,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct RequestRedemptionOnyc<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = usdc_mint,
        has_one = onyc_mint,
        has_one = fee_vault,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub onyc_mint: InterfaceAccount<'info, Mint>,

    /// Pre-balance snapshot for `claim_redemption_usdc` delta.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Source for fee transfer; OnRe's CPI also pulls from here.
    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = onyc_mint,
        token::token_program = token_program,
    )]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated transitively via the flow PDA seeds.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = outflight_flow.bump,
    )]
    pub outflight_flow: Account<'info, Flow>,

    /// Singleton init — fails if a prior redemption is mid-flight.
    /// On-chain mutex that makes the ATA-delta math safe.
    #[account(
        init,
        payer = payer,
        space = 8 + RedemptionTracker::INIT_SPACE,
        seeds = [REDEMPTION_TRACKER_SEED],
        bump,
    )]
    pub redemption_tracker: Account<'info, RedemptionTracker>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
