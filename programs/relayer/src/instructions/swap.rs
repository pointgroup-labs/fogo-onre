//! Route-agnostic swap.

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
        program_option::COption,
    },
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::RELAYER_SEED,
    cpi::{approve_swap_delegate, relayer_signed_transfer_checked, revoke_relayer_delegate},
    error::RelayerError,
    events::Swapped,
    state::{Direction, Flow, FlowStatus, PairConfig},
};

/// Routes on `flow.direction`: deposit base→asset (fee from asset OUTPUT),
/// withdraw asset→base (fee from asset INPUT). Fee is always asset-denominated;
/// the output floor is the user-signed `flow.min_swap_out` (no protocol band).
pub fn handler<'info>(ctx: Context<'info, Swap<'info>>, swap_ix_data: Vec<u8>) -> Result<()> {
    let flow_key = ctx.accounts.flow.key();
    let direction = ctx.accounts.flow.direction;
    require!(ctx.accounts.flow.status == FlowStatus::Received, RelayerError::FlowStatusMismatch);

    let cfg = &ctx.accounts.pair_config;

    // Re-entry is already blocked via the forbidden relayer_config; forbidding
    // a self-CPI swap_program makes it explicit.
    require_keys_neq!(ctx.accounts.swap_program.key(), crate::ID, RelayerError::SwapAccountNotAllowed);

    let base_ata_key = ctx.accounts.base_ata.key();
    let asset_ata_key = ctx.accounts.asset_ata.key();
    let auth_key = ctx.accounts.relayer_authority.key();

    let forbidden = [ctx.accounts.fee_vault.key(), ctx.accounts.pair_config.key(), flow_key];

    for acc in ctx.remaining_accounts.iter() {
        require!(!forbidden.contains(acc.key), RelayerError::SwapAccountNotAllowed);
        if *acc.key == base_ata_key || *acc.key == asset_ata_key {
            continue;
        }
        if let Ok(ta) = InterfaceAccount::<TokenAccount>::try_from(acc) {
            require!(ta.owner != auth_key, RelayerError::SwapAccountNotAllowed);
        }
    }

    let authority_bump = cfg.relayer_authority_bump;
    let asset_decimals = ctx.accounts.asset_mint.decimals;
    let gross_in = ctx.accounts.flow.amount;

    // User-signed floor (output-token atomic units); enforced post-CPI.
    let floor = ctx.accounts.flow.min_swap_out;

    require!(gross_in > 0, RelayerError::ZeroAmountFlow);

    let deposit = matches!(direction, Direction::Deposit);

    let token_program_info = ctx.accounts.token_program.to_account_info();
    let asset_ata_info = ctx.accounts.asset_ata.to_account_info();
    let asset_mint_info = ctx.accounts.asset_mint.to_account_info();
    let fee_vault_info = ctx.accounts.fee_vault.to_account_info();
    let authority_info = ctx.accounts.relayer_authority.to_account_info();
    // Asset-denominated fee skim; no-ops on zero (see relayer_signed_transfer_checked).
    let skim_fee = |amount: u64| {
        relayer_signed_transfer_checked(
            &token_program_info,
            &asset_ata_info,
            &asset_mint_info,
            &fee_vault_info,
            &authority_info,
            authority_bump,
            amount,
            asset_decimals,
        )
    };

    let (swap_in, fee_before) = if deposit {
        (gross_in, 0u64)
    } else {
        let (net, fee) = cfg.apply_withdraw_fee(gross_in)?;
        require!(net > 0, RelayerError::ZeroAmountFlow);
        skim_fee(fee)?;
        (net, fee)
    };

    ctx.accounts.base_ata.reload()?;
    ctx.accounts.asset_ata.reload()?;
    let (in_before, out_before) = in_out(deposit, ctx.accounts.base_ata.amount, ctx.accounts.asset_ata.amount);
    require!(in_before >= swap_in, RelayerError::ZeroAmountFlow);

    // Clear any pre-existing delegate before the swap so stale residue can't
    // DoS the post-CPI pristine-ATA assert (which still rejects CPI-added ones).
    let token_program_info = ctx.accounts.token_program.to_account_info();
    let relayer_authority_info = ctx.accounts.relayer_authority.to_account_info();
    revoke_relayer_delegate(
        &token_program_info,
        &ctx.accounts.base_ata.to_account_info(),
        &relayer_authority_info,
        authority_bump,
    )?;
    revoke_relayer_delegate(
        &token_program_info,
        &ctx.accounts.asset_ata.to_account_info(),
        &relayer_authority_info,
        authority_bump,
    )?;

    if ctx.accounts.swap_delegate.key() != auth_key {
        let in_ata_info =
            if deposit { ctx.accounts.base_ata.to_account_info() } else { ctx.accounts.asset_ata.to_account_info() };
        approve_swap_delegate(
            &ctx.accounts.token_program.to_account_info(),
            &in_ata_info,
            &ctx.accounts.relayer_authority,
            authority_bump,
            &ctx.accounts.swap_delegate,
            swap_in,
        )?;
    }

    // Snapshot the signing PDA's lamports/owner/data to assert post-CPI the
    // router didn't drain or reassign it.
    let auth_info = ctx.accounts.relayer_authority.to_account_info();
    let auth_lamports_pre = auth_info.lamports();
    let auth_owner_pre = *auth_info.owner;

    let metas: Vec<AccountMeta> = ctx
        .remaining_accounts
        .iter()
        .map(|a| {
            let is_auth = *a.key == auth_key;
            AccountMeta { pubkey: *a.key, is_signer: a.is_signer || is_auth, is_writable: a.is_writable }
        })
        .collect();

    invoke_signed(
        &Instruction { program_id: *ctx.accounts.swap_program.key, accounts: metas, data: swap_ix_data },
        ctx.remaining_accounts,
        &[&[RELAYER_SEED, &[authority_bump]]],
    )?;

    require!(auth_info.lamports() >= auth_lamports_pre, RelayerError::RelayerAuthorityTampered);
    require_keys_eq!(*auth_info.owner, auth_owner_pre, RelayerError::RelayerAuthorityTampered);
    require!(auth_info.data_is_empty(), RelayerError::RelayerAuthorityTampered);

    ctx.accounts.base_ata.reload()?;
    ctx.accounts.asset_ata.reload()?;
    let (in_after, out_after) = in_out(deposit, ctx.accounts.base_ata.amount, ctx.accounts.asset_ata.amount);
    let in_consumed = in_before.checked_sub(in_after).ok_or(RelayerError::BalanceUnderflow)?;
    let out_received = out_after.checked_sub(out_before).ok_or(RelayerError::BalanceUnderflow)?;
    require!(in_consumed == swap_in, RelayerError::InputConsumedMismatch);
    require!(out_received >= floor, RelayerError::OutputBelowFloor);

    assert_ata_untampered(&ctx.accounts.base_ata, &auth_key)?;
    assert_ata_untampered(&ctx.accounts.asset_ata, &auth_key)?;

    let (net_out, fee) = if deposit {
        let (net, fee) = ctx.accounts.pair_config.apply_deposit_fee(out_received)?;
        skim_fee(fee)?;
        (net, fee)
    } else {
        (out_received, fee_before)
    };

    let flow = &mut ctx.accounts.flow;
    flow.amount = net_out;
    flow.status = FlowStatus::Swapped;

    emit!(Swapped {
        flow: flow_key,
        direction,
        gross_in,
        fee,
        net_out,
        floor,
        swap_program: *ctx.accounts.swap_program.key,
    });

    Ok(())
}

/// `(input, output)` balances for the swap leg: deposit spends base for asset,
/// withdraw spends asset for base.
fn in_out(deposit: bool, base: u64, asset: u64) -> (u64, u64) {
    if deposit { (base, asset) } else { (asset, base) }
}

/// The swap CPI must leave the relayer's operating ATAs pristine: owned by the
/// PDA, with no standing delegate or close authority. The handler revokes any
/// delegate before the swap CPI, so a residual `Some` here means the CPI
/// re-approved one afterward — treated as tampering.
fn assert_ata_untampered(ata: &InterfaceAccount<'_, TokenAccount>, expected_owner: &Pubkey) -> Result<()> {
    require_keys_eq!(ata.owner, *expected_owner, RelayerError::AtaAuthorityTampered);
    require!(matches!(ata.delegate, COption::None), RelayerError::AtaAuthorityTampered);
    require!(ata.delegated_amount == 0, RelayerError::AtaAuthorityTampered);
    require!(matches!(ata.close_authority, COption::None), RelayerError::AtaAuthorityTampered);
    Ok(())
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        seeds = [PairConfig::SEED, base_mint.key().as_ref(), asset_mint.key().as_ref()],
        bump = pair_config.bump,
        has_one = base_mint,
        has_one = asset_mint,
        has_one = fee_vault,
    )]
    pub pair_config: Box<Account<'info, PairConfig>>,

    /// CHECK: PDA seeds enforce identity; signs the Approve, fee transfer,
    /// and swap CPI. Reach bounded by the post-CPI ATA assertions.
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

    /// Fee destination — always denominated in the asset token.
    #[account(mut, token::mint = asset_mint, token::token_program = token_program)]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated transitively via the flow PDA seed binding.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [Flow::seed(flow.direction), pair_config.key().as_ref(), ntt_inbox_item.key().as_ref()],
        bump = flow.bump,
    )]
    pub flow: Box<Account<'info, Flow>>,

    /// CHECK: router-agnostic. Safety comes from the signed floor and bounded
    /// delegation, not program identity.
    pub swap_program: UncheckedAccount<'info>,

    /// CHECK: SPL delegate the router spends from `in_ata`. Pass
    /// `relayer_authority` as a sentinel for owner-signed routers.
    pub swap_delegate: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
