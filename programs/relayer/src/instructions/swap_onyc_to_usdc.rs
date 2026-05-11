//! Permissionless ONyc→USDC conversion for outbound (withdraw-leg) flows.
//!
//! OnRe redemptions are KYC-gated — the relayer PDA cannot complete KYC —
//! so this handler goes directly to a third-party swap program (Jupiter
//! today; aggregator-agnostic in the account layout) to convert the
//! unlocked ONyc into USDC for the user.
//!
//! Damage per call is bounded by three independent layers:
//!
//! 1. NAV-anchored floor derived from OnRe's deposit-side `Offer` pricing
//!    vector — on-chain oracle, not operator-supplied.
//! 2. SPL `Approve` bounded to exactly `flow.amount - fee`; the swap CPI
//!    runs under plain `invoke`, so PDA-signer privilege does not propagate.
//! 3. `MAX_SLIPPAGE_BPS` is the security boundary — keep tight.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, MAX_SLIPPAGE_BPS, ONRE_DEPOSIT_OFFER_SEED, ONRE_PROGRAM_ID,
    RELAYER_SEED,
};
use crate::cpi::{approve_swap_delegate, relayer_signed_transfer_checked};
use crate::error::RelayerError;
use crate::events::OnycSwappedToUsdc;
use crate::onre::{
    apply_slippage_floor, calculate_step_price, parse_active_offer_vector, redemption_expected_out,
};
use crate::state::{Flow, FlowStatus, RelayerConfig};

pub fn handler<'info>(
    ctx: Context<'info, SwapOnycToUsdc<'info>>,
    swap_ix_data: Vec<u8>,
) -> Result<()> {
    let clock = Clock::get()?;
    let now_unix = clock.unix_timestamp as u64;

    let flow_key = ctx.accounts.outflight_flow.key();
    let gross_onyc = ctx.accounts.outflight_flow.amount;

    require!(
        ctx.accounts.outflight_flow.status == FlowStatus::Claimed,
        RelayerError::FlowStatusMismatch
    );
    require!(gross_onyc > 0, RelayerError::ZeroAmountFlow);

    // 1. Fee deduction — withdraw fee in ONyc, paid out of the unlocked
    //    amount before the swap.
    let (net_onyc, fee_onyc) = ctx.accounts.relayer_config.apply_withdraw_fee(gross_onyc)?;
    let authority_bump = ctx.accounts.relayer_config.relayer_authority_bump;

    if fee_onyc > 0 {
        relayer_signed_transfer_checked(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.onyc_ata.to_account_info(),
            &ctx.accounts.onyc_mint.to_account_info(),
            &ctx.accounts.fee_vault_onyc_ata.to_account_info(),
            &ctx.accounts.relayer_authority,
            authority_bump,
            fee_onyc,
            ctx.accounts.onyc_mint.decimals,
        )?;
    }

    require!(net_onyc > 0, RelayerError::ZeroAmountFlow);

    // 2. NAV floor — pin onre_offer to (owner == ONRE_PROGRAM_ID) AND
    //    (key == deposit Offer PDA for the bound mints) before reading bytes.
    require_keys_eq!(
        *ctx.accounts.onre_offer.owner,
        ONRE_PROGRAM_ID,
        RelayerError::OnreOfferOwnerMismatch
    );
    let (expected_offer_pda, _bump) = Pubkey::find_program_address(
        &[
            ONRE_DEPOSIT_OFFER_SEED,
            ctx.accounts.relayer_config.usdc_mint.as_ref(),
            ctx.accounts.relayer_config.onyc_mint.as_ref(),
        ],
        &ONRE_PROGRAM_ID,
    );
    require_keys_eq!(
        ctx.accounts.onre_offer.key(),
        expected_offer_pda,
        RelayerError::OnreOfferAddressMismatch
    );

    let nav_floor: u64 = {
        let offer_data = ctx.accounts.onre_offer.try_borrow_data()?;
        require!(
            offer_data.len() >= crate::constants::ONRE_OFFER_ACCOUNT_SIZE,
            RelayerError::OnreOfferTooShort
        );
        let in_mint = Pubkey::try_from(&offer_data[8..40])
            .map_err(|_| error!(RelayerError::OnreOfferTooShort))?;
        let out_mint = Pubkey::try_from(&offer_data[40..72])
            .map_err(|_| error!(RelayerError::OnreOfferTooShort))?;
        require_keys_eq!(
            in_mint,
            ctx.accounts.relayer_config.usdc_mint,
            RelayerError::OnreOfferTokenInMintMismatch
        );
        require_keys_eq!(
            out_mint,
            ctx.accounts.relayer_config.onyc_mint,
            RelayerError::OnreOfferTokenOutMintMismatch
        );
        let active = parse_active_offer_vector(&offer_data, now_unix)?;
        let price = calculate_step_price(&active, now_unix)?;
        let gross_expected = redemption_expected_out(
            net_onyc,
            price,
            ctx.accounts.onyc_mint.decimals,
            ctx.accounts.usdc_mint.decimals,
        )?;
        apply_slippage_floor(gross_expected, MAX_SLIPPAGE_BPS)?
    };

    // 3. Reload after fee transfer; assert sufficient post-fee balance.
    ctx.accounts.onyc_ata.reload()?;
    require!(
        ctx.accounts.onyc_ata.amount >= net_onyc,
        RelayerError::ZeroAmountFlow
    );
    let onyc_before = ctx.accounts.onyc_ata.amount;
    let usdc_before = ctx.accounts.usdc_ata.amount;

    // 4. Bounded SPL Approve to swap_delegate for exactly net_onyc.
    approve_swap_delegate(
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.onyc_ata.to_account_info(),
        &ctx.accounts.relayer_authority,
        authority_bump,
        &ctx.accounts.swap_delegate,
        net_onyc,
    )?;

    // 5. Plain `invoke` (NEVER invoke_signed) — operator cannot launder
    //    relayer_authority into the swap as a signer; account-meta signer
    //    flags are forwarded verbatim.
    let metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: *a.key,
            is_signer: a.is_signer,
            is_writable: a.is_writable,
        })
        .collect();
    invoke(
        &Instruction {
            program_id: *ctx.accounts.swap_program.key,
            accounts: metas,
            data: swap_ix_data,
        },
        ctx.remaining_accounts,
    )?;

    // 6. Exact-consume on ONyc, floor-check on USDC.
    ctx.accounts.onyc_ata.reload()?;
    ctx.accounts.usdc_ata.reload()?;
    let onyc_consumed = onyc_before
        .checked_sub(ctx.accounts.onyc_ata.amount)
        .ok_or(RelayerError::BalanceUnderflow)?;
    let usdc_received = ctx
        .accounts
        .usdc_ata
        .amount
        .checked_sub(usdc_before)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(
        onyc_consumed == net_onyc,
        RelayerError::OnycConsumedMismatch
    );
    require!(
        usdc_received >= nav_floor,
        RelayerError::RedeemSlippageBelowFloor
    );

    // 7. Flip status; overwrite flow.amount with usdc_received for
    //    `send_usdc_to_user` to consume.
    let flow = &mut ctx.accounts.outflight_flow;
    flow.amount = usdc_received;
    flow.status = FlowStatus::Swapped;

    emit!(OnycSwappedToUsdc {
        flow: flow_key,
        gross_onyc,
        fee_onyc,
        net_onyc,
        onyc_consumed,
        usdc_received,
        nav_floor,
        swap_program: *ctx.accounts.swap_program.key,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SwapOnycToUsdc<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = onyc_mint,
        has_one = usdc_mint,
        has_one = fee_vault,
    )]
    pub relayer_config: Box<Account<'info, RelayerConfig>>,

    /// CHECK: signs only the SPL Approve and the fee transfer; swap CPI
    /// uses plain `invoke`, so PDA-signer privilege does not propagate.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub onyc_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: pinned to relayer_config.fee_vault via has_one. ATA's
    /// authority is the fee_vault wallet (off-chain key, configurable).
    pub fee_vault: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = fee_vault,
        associated_token::token_program = token_program,
    )]
    pub fee_vault_onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated transitively via the flow PDA seed binding.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = outflight_flow.bump,
    )]
    pub outflight_flow: Box<Account<'info, Flow>>,

    /// CHECK: handler enforces (owner == ONRE_PROGRAM_ID) AND
    /// (key == PDA([b"offer", usdc_mint, onyc_mint], ONRE_PROGRAM_ID)).
    /// Untyped because OnRe's struct is in a foreign crate; layout is
    /// mirrored via byte offsets in `onre.rs`.
    pub onre_offer: UncheckedAccount<'info>,

    /// CHECK: router-agnostic by design. Safety comes from the NAV-anchored
    /// post-balance invariant and the bounded SPL delegation, not the
    /// program identity.
    pub swap_program: UncheckedAccount<'info>,

    /// CHECK: SPL delegate the swap spends from `onyc_ata`. Bounded by the
    /// Approve to exactly `net_onyc`; SPL auto-clears at zero remaining.
    pub swap_delegate: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
