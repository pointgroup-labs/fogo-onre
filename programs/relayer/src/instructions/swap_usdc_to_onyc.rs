use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_INBOUND_SEED, ONRE_PROGRAM_ID, ONRE_TAKE_OFFER_IX, RELAYER_SEED,
};
use crate::cpi::{invoke_relayer_signed, relayer_signed_transfer_checked};
use crate::error::RelayerError;
use crate::events::Swapped;
use crate::onre::{
    apply_slippage_floor, deposit_expected_out, read_offer_nav_price, OnreTakeOfferArgs,
};
use crate::state::{Direction, Flow, FlowStatus, RelayerConfig};

/// Permissionless. Swaps `flow.amount` USDC into ONyc via OnRe, then
/// skims the deposit-leg fee from the ONyc output to `fee_vault`.
pub fn handler<'info>(ctx: Context<'info, SwapUsdcToOnyc<'info>>) -> Result<()> {
    let flow_key = ctx.accounts.inflight_flow.key();
    let now_unix = u64::try_from(Clock::get()?.unix_timestamp)
        .map_err(|_| error!(RelayerError::OnreNavOverflow))?;

    require!(
        ctx.accounts.inflight_flow.status == FlowStatus::Received,
        RelayerError::FlowStatusMismatch
    );
    let usdc_in = ctx.accounts.inflight_flow.amount;
    require!(usdc_in > 0, RelayerError::ZeroAmountFlow);

    // NAV floor — pin onre_offer to OnRe's deposit Offer PDA for the bound
    // mints, read its step price, derive the slippage-adjusted min-out.
    let price = read_offer_nav_price(
        &ctx.accounts.onre_offer.to_account_info(),
        &ctx.accounts.relayer_config.base_mint,
        &ctx.accounts.relayer_config.asset_mint,
        now_unix,
    )?;
    let onyc_floor = {
        let gross_expected = deposit_expected_out(
            usdc_in,
            price,
            ctx.accounts.base_mint.decimals,
            ctx.accounts.asset_mint.decimals,
        )?;
        apply_slippage_floor(gross_expected, ctx.accounts.relayer_config.max_slippage_bps)?
    };

    let onyc_pre = ctx.accounts.asset_ata.amount;
    let usdc_pre = ctx.accounts.base_ata.amount;

    invoke_relayer_signed(
        ONRE_PROGRAM_ID,
        &ONRE_TAKE_OFFER_IX,
        &OnreTakeOfferArgs {
            amount: usdc_in,
            approval_message: None,
        },
        ctx.remaining_accounts,
        Some(&ctx.accounts.relayer_authority.to_account_info()),
        ctx.accounts.relayer_config.relayer_authority_bump,
    )?;

    ctx.accounts.asset_ata.reload()?;
    ctx.accounts.base_ata.reload()?;
    let gross = ctx
        .accounts
        .asset_ata
        .amount
        .checked_sub(onyc_pre)
        .ok_or(RelayerError::BalanceUnderflow)?;
    let usdc_consumed = usdc_pre
        .checked_sub(ctx.accounts.base_ata.amount)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(gross > 0, RelayerError::ZeroAmountFlow);
    require!(usdc_consumed == usdc_in, RelayerError::UsdcConsumedMismatch);
    require!(gross >= onyc_floor, RelayerError::DepositSlippageBelowFloor);

    // `configure`'s asymmetric timelock prevents retroactive raises.
    let (net, fee) = ctx.accounts.relayer_config.apply_deposit_fee(gross)?;

    relayer_signed_transfer_checked(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.asset_ata.to_account_info(),
        &ctx.accounts.asset_mint.to_account_info(),
        &ctx.accounts.fee_vault.to_account_info(),
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
        fee,
        ctx.accounts.asset_mint.decimals,
    )?;

    let flow = &mut ctx.accounts.inflight_flow;
    flow.amount = net;
    flow.status = FlowStatus::Swapped;

    emit!(Swapped {
        flow: flow_key,
        direction: Direction::Deposit,
        gross_in: gross,
        fee,
        net_out: net,
        floor: onyc_floor,
        swap_program: ONRE_PROGRAM_ID,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SwapUsdcToOnyc<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = base_mint,
        has_one = asset_mint,
        has_one = fee_vault,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA seeds enforce identity; signs OnRe CPI.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub base_mint: InterfaceAccount<'info, Mint>,
    pub asset_mint: InterfaceAccount<'info, Mint>,

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

    #[account(
        mut,
        token::mint = asset_mint,
        token::token_program = token_program,
    )]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated transitively via the flow PDA seeds.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    /// CHECK: handler enforces (owner == ONRE_PROGRAM_ID) AND
    /// (key == PDA([b"offer", usdc_mint, onyc_mint], ONRE_PROGRAM_ID)).
    /// Read-only pricing oracle for the deposit-leg NAV floor; the same
    /// account is also forwarded inside `remaining_accounts` to take_offer.
    pub onre_offer: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [FLOW_INBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = inflight_flow.bump,
    )]
    pub inflight_flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
}
