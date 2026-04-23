use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{
    CONFIG_SEED, DEPOSIT_AUTHORITY_SEED, FLOW_INBOUND_SEED, ONRE_PROGRAM_ID, ONRE_TAKE_OFFER_IX,
    RELAYER_SEED,
};
use crate::cpi::invoke_deposit_signed;
use crate::error::RelayerError;
use crate::events::OnycSwapped;
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// OnRe `take_offer_permissionless` args. The relayer always targets
/// permissionless offers, so `approval_message` is `None`.
#[derive(AnchorSerialize)]
struct OnreTakeOfferArgs {
    amount: u64,
    approval_message: Option<Vec<u8>>,
}

/// Permissionless. Swaps the flow's USDC into ONyc via OnRe, then takes the
/// deposit-leg fee from the ONyc output and routes it to `fee_vault`.
/// Operates on `flow.amount` (not full ATA balance) so concurrent flows
/// stay isolated.
///
/// ## Two-authority deposit chain (introduced for withdraw-chain isolation)
///
/// OnRe's `take_offer_permissionless` constrains both
/// `user_token_in_account` and `user_token_out_account` to
/// `associated_token::authority = user`. We sign as `deposit_authority`
/// (NOT `relayer_authority`) so OnRe's USDC drain comes from
/// `deposit_usdc_ata` and ONyc lands in `deposit_onyc_ata`. We then move
/// the received ONyc into the relayer-authority-owned `onyc_ata` so
/// `lock_onyc` keeps reading from the same long-lived account it always
/// has. The deposit-side ATAs become a transient routing pair; only USDC
/// IN and ONyc OUT pass through them, leaving `usdc_ata`
/// (relayer-authority-owned) free of deposit-side traffic — which is what
/// makes the withdraw-chain `claim_redemption_usdc` snapshot/delta math
/// correct under concurrent traffic.
pub fn handler<'info>(ctx: Context<'info, SwapUsdcToOnyc<'info>>) -> Result<()> {
    let flow_key = ctx.accounts.inflight_flow.key();

    require!(
        ctx.accounts.inflight_flow.status == FlowStatus::Claimed,
        RelayerError::FlowStatusMismatch
    );
    require!(
        ctx.accounts.inflight_flow.amount > 0,
        RelayerError::ZeroAmountFlow
    );

    let deposit_onyc_pre = ctx.accounts.deposit_onyc_ata.amount;

    invoke_deposit_signed(
        ONRE_PROGRAM_ID,
        &ONRE_TAKE_OFFER_IX,
        &OnreTakeOfferArgs {
            amount: ctx.accounts.inflight_flow.amount,
            approval_message: None,
        },
        ctx.remaining_accounts,
        &ctx.accounts.deposit_authority.to_account_info(),
        ctx.bumps.deposit_authority,
    )?;

    ctx.accounts.deposit_onyc_ata.reload()?;
    let received = ctx
        .accounts
        .deposit_onyc_ata
        .amount
        .checked_sub(deposit_onyc_pre)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(received > 0, RelayerError::ZeroAmountFlow);

    // Hand received ONyc off to the relayer-authority-owned `onyc_ata` so
    // `lock_onyc`'s account graph stays unchanged. Signed by the deposit
    // authority that just took ownership via OnRe.
    let dep_bump = [ctx.bumps.deposit_authority];
    let dep_seeds: &[&[u8]] = &[DEPOSIT_AUTHORITY_SEED, &dep_bump];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.deposit_onyc_ata.to_account_info(),
                mint: ctx.accounts.onyc_mint.to_account_info(),
                to: ctx.accounts.onyc_ata.to_account_info(),
                authority: ctx.accounts.deposit_authority.to_account_info(),
            },
            &[dep_seeds],
        ),
        received,
        ctx.accounts.onyc_mint.decimals,
    )?;

    // Deposit fee is taken POST-swap from the ONyc output, on the relayer
    // authority's onyc_ata (where we just routed the received ONyc).
    let gross = received;
    let (net, fee) = ctx.accounts.relayer_config.apply_deposit_fee(gross)?;

    if fee > 0 {
        let auth_bump = [ctx.accounts.relayer_config.relayer_authority_bump];
        let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump];
        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.onyc_ata.to_account_info(),
                    mint: ctx.accounts.onyc_mint.to_account_info(),
                    to: ctx.accounts.fee_vault.to_account_info(),
                    authority: ctx.accounts.relayer_authority.to_account_info(),
                },
                &[auth_seeds],
            ),
            fee,
            ctx.accounts.onyc_mint.decimals,
        )?;
    }

    let flow = &mut ctx.accounts.inflight_flow;
    flow.amount = net;
    flow.status = FlowStatus::Swapped;

    emit!(OnycSwapped {
        flow: flow_key,
        gross_amount: gross,
        fee_amount: fee,
        net_amount: net,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SwapUsdcToOnyc<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = usdc_mint,
        has_one = onyc_mint,
        has_one = fee_vault,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED. Signs the post-swap fee
    /// transfer out of `onyc_ata` to `fee_vault`.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    /// CHECK: PDA derived from DEPOSIT_AUTHORITY_SEED. Signs the OnRe CPI
    /// (as `user`) and the post-swap ONyc handoff into `onyc_ata`. Bump
    /// runtime-derived (not persisted on `RelayerConfig`).
    #[account(seeds = [DEPOSIT_AUTHORITY_SEED], bump)]
    pub deposit_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub onyc_mint: InterfaceAccount<'info, Mint>,

    /// Deposit-leg USDC source for the OnRe `take_offer_permissionless` CPI.
    /// Owned by `deposit_authority`; OnRe enforces
    /// `user_token_in_account.authority == user` so this is the only USDC
    /// account OnRe will accept here.
    /// Boxed: `try_accounts` for this struct overflows the eBPF 4 KiB stack
    /// budget when every `InterfaceAccount<TokenAccount>` materialises
    /// inline (~165 B each + alignment). Boxing pushes them to the heap
    /// without changing semantics.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = deposit_authority,
        associated_token::token_program = token_program,
    )]
    pub deposit_usdc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Transient deposit-leg ONyc sink. OnRe's
    /// `user_token_out_account.authority == user` constraint forces this
    /// to be the deposit_authority's ATA. We immediately drain it into
    /// `onyc_ata` post-CPI. Boxed for the same stack-budget reason as
    /// `deposit_usdc_ata`.
    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = deposit_authority,
        associated_token::token_program = token_program,
    )]
    pub deposit_onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Long-lived ONyc account that downstream `lock_onyc` reads from.
    /// Boxed for the same stack-budget reason as the deposit ATAs above.
    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Pinned by `has_one = fee_vault`. Any pre-existing ONyc account;
    /// need not be relayer-owned.
    #[account(
        mut,
        token::mint = onyc_mint,
        token::token_program = token_program,
    )]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated transitively via the flow PDA seeds.
    pub gateway_claim: UncheckedAccount<'info>,

    /// Created by `claim_usdc`; must be in `Claimed` status.
    #[account(
        mut,
        seeds = [FLOW_INBOUND_SEED, gateway_claim.key().as_ref()],
        bump = inflight_flow.bump,
    )]
    pub inflight_flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
}
