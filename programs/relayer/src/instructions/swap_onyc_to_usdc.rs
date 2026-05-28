//! Permissionless ONyc→USDC conversion for outbound (withdraw-leg) flows.
//!
//! OnRe redemptions are KYC-gated — the relayer PDA cannot complete KYC —
//! so this handler goes directly to a third-party swap program (Jupiter
//! today; aggregator-agnostic in the account layout) to convert the
//! unlocked ONyc into USDC for the user.
//!
//! Damage per call is bounded by independent layers:
//!
//! 1. NAV-anchored floor derived from OnRe's deposit-side `Offer` pricing
//!    vector — on-chain oracle, not operator-supplied.
//! 2. SPL `Approve` bounded to exactly `flow.amount - fee`; this is the
//!    only token-spend surface the swap can reach.
//! 3. The swap CPI is signed by `relayer_authority` (Jupiter's
//!    `userTransferAuthority` model), so post-CPI we assert the ATAs'
//!    `owner`/`delegate`/`delegated_amount`/`close_authority` are pristine
//!    — any `SetAuthority`/`Approve` a malicious router smuggled in reverts
//!    the whole tx atomically, defeating PDA-signer privilege extension.
//! 4. `slippage_bps` (authority-tunable, capped at `MAX_SLIPPAGE_BPS`) is
//!    the NAV-floor boundary — keep tight.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{CONFIG_SEED, FLOW_OUTBOUND_SEED, RELAYER_SEED};
use crate::cpi::{approve_swap_delegate, relayer_signed_transfer_checked};
use crate::error::RelayerError;
use crate::events::OnycSwappedToUsdc;
use crate::onre::{apply_slippage_floor, read_offer_nav_price, redemption_expected_out};
use crate::state::{Flow, FlowStatus, RelayerConfig};

pub fn handler<'info>(
    ctx: Context<'info, SwapOnycToUsdc<'info>>,
    swap_ix_data: Vec<u8>,
) -> Result<()> {
    let clock = Clock::get()?;
    let now_unix =
        u64::try_from(clock.unix_timestamp).map_err(|_| error!(RelayerError::OnreNavOverflow))?;

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
            &ctx.accounts.fee_vault.to_account_info(),
            &ctx.accounts.relayer_authority,
            authority_bump,
            fee_onyc,
            ctx.accounts.onyc_mint.decimals,
        )?;
    }

    require!(net_onyc > 0, RelayerError::ZeroAmountFlow);

    // 2. NAV floor — pin onre_offer to OnRe's deposit Offer PDA for the
    //    bound mints, read its step price, derive the slippage floor.
    let nav_floor: u64 = {
        let price = read_offer_nav_price(
            &ctx.accounts.onre_offer.to_account_info(),
            &ctx.accounts.relayer_config.usdc_mint,
            &ctx.accounts.relayer_config.onyc_mint,
            now_unix,
        )?;
        let gross_expected = redemption_expected_out(
            net_onyc,
            price,
            ctx.accounts.onyc_mint.decimals,
            ctx.accounts.usdc_mint.decimals,
        )?;
        apply_slippage_floor(gross_expected, ctx.accounts.relayer_config.slippage_bps)?
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

    // 5. CPI into the router under `invoke_signed` so relayer_authority
    //    can sign Jupiter's `userTransferAuthority` slot. This extends the
    //    PDA's signer privilege into the callee, so step 6b re-asserts the
    //    ATAs were not re-authoritied/delegated/closed by a hostile router.
    let auth_key = ctx.accounts.relayer_authority.key();
    let metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: *a.key,
            is_signer: a.is_signer || *a.key == auth_key,
            is_writable: a.is_writable,
        })
        .collect();
    invoke_signed(
        &Instruction {
            program_id: *ctx.accounts.swap_program.key,
            accounts: metas,
            data: swap_ix_data,
        },
        ctx.remaining_accounts,
        &[&[RELAYER_SEED, &[authority_bump]]],
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

    // 6b. PDA-signer privilege defense: the signed swap CPI could have
    //     smuggled an SPL SetAuthority/Approve on our ATAs. Require both
    //     ATAs pristine — owner unchanged, no lingering delegate, no
    //     close_authority. The exact-consume above forces the bounded
    //     delegate to zero, so a leftover delegation here means the router
    //     spent via the PDA signer instead and must revert.
    assert_ata_untampered(&ctx.accounts.onyc_ata, &auth_key)?;
    assert_ata_untampered(&ctx.accounts.usdc_ata, &auth_key)?;

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

/// Reverts if a signed swap CPI re-authoritied, delegated, or armed
/// close on a relayer ATA. Catches PDA-signer privilege extension within
/// the same transaction.
fn assert_ata_untampered(
    ata: &InterfaceAccount<'_, TokenAccount>,
    expected_owner: &Pubkey,
) -> Result<()> {
    require_keys_eq!(
        ata.owner,
        *expected_owner,
        RelayerError::AtaAuthorityTampered
    );
    require!(
        matches!(ata.delegate, COption::None),
        RelayerError::AtaAuthorityTampered
    );
    require!(
        ata.delegated_amount == 0,
        RelayerError::AtaAuthorityTampered
    );
    require!(
        matches!(ata.close_authority, COption::None),
        RelayerError::AtaAuthorityTampered
    );
    Ok(())
}

#[derive(Accounts)]
pub struct SwapOnycToUsdc<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = onyc_mint,
        has_one = usdc_mint,
        has_one = fee_vault,
    )]
    pub relayer_config: Box<Account<'info, RelayerConfig>>,

    /// CHECK: signs the SPL Approve, fee transfer, and the swap CPI; the
    /// swap's reach is bounded by the bounded Approve and re-checked by the
    /// post-CPI authority assertions in the handler.
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

    /// Fee destination — the ONyc token account configured at
    /// `initialize` / `configure` time (pinned via `has_one`). Receives
    /// the withdraw-fee transfer directly; no derived child ATA.
    #[account(
        mut,
        token::mint = onyc_mint,
        token::token_program = token_program,
    )]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

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
