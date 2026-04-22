use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{CONFIG_SEED, FLOW_INBOUND_SEED, RELAYER_SEED};
use crate::events::OnycSwapped;
use crate::onre::execute_onre_swap;
use crate::state::{Flow, RelayerConfig};

/// Permissionless. Swaps the flow's USDC into ONyc via OnRe, then takes the
/// deposit-leg fee from the ONyc output and routes it to `fee_vault`.
/// Operates on `flow.amount` (not full ATA balance) so concurrent flows
/// stay isolated.
pub fn handler<'info>(ctx: Context<'info, SwapUsdcToOnyc<'info>>) -> Result<()> {
    let flow_key = ctx.accounts.inflight_flow.key();

    // Post-conditions: flow.amount = ONyc received, flow.status = Swapped.
    execute_onre_swap(
        &mut ctx.accounts.inflight_flow,
        &mut ctx.accounts.onyc_ata,
        &ctx.accounts.relayer_authority.to_account_info(),
        &ctx.accounts.relayer_config,
        ctx.remaining_accounts,
    )?;

    // Deposit fee is taken POST-swap from the ONyc output.
    let gross = ctx.accounts.inflight_flow.amount;
    let (net, fee) = ctx.accounts.relayer_config.apply_deposit_fee(gross)?;

    // Physically segregate fees so `onyc_ata` holds only in-flight user funds.
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

    ctx.accounts.inflight_flow.amount = net;

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

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub onyc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = onyc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub onyc_ata: InterfaceAccount<'info, TokenAccount>,

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
