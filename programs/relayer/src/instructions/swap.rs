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
    constants::{CONFIG_SEED, RELAYER_SEED},
    cpi::{approve_swap_delegate, relayer_signed_transfer_checked, revoke_relayer_delegate},
    error::RelayerError,
    events::Swapped,
    onre::{apply_slippage_floor, oracle_expected_out, read_offer_nav_price},
    state::{Direction, Flow, FlowStatus, RelayerConfig},
};

/// Routes on `flow.direction`: deposit base→asset (fee from asset OUTPUT),
/// withdraw asset→base (fee from asset INPUT). Fee is always asset-denominated;
/// the output floor is the config-pinned OnRe NAV minus `max_slippage_bps`.
pub fn handler<'info>(ctx: Context<'info, Swap<'info>>, swap_ix_data: Vec<u8>) -> Result<()> {
    let now_unix = u64::try_from(Clock::get()?.unix_timestamp).map_err(|_| error!(RelayerError::OnreNavOverflow))?;

    let flow_key = ctx.accounts.flow.key();
    let direction = ctx.accounts.flow.direction;
    require!(ctx.accounts.flow.status == FlowStatus::Received, RelayerError::FlowStatusMismatch);

    let cfg = &ctx.accounts.relayer_config;
    require!(cfg.price_oracle != Pubkey::default(), RelayerError::BadPriceOracle);
    require_keys_eq!(ctx.accounts.onre_offer.key(), cfg.price_oracle, RelayerError::BadPriceOracle);

    // Defense-in-depth: re-entry is already blocked by the forbidden
    // relayer_config; forbidding a self-CPI swap_program makes it explicit.
    require_keys_neq!(ctx.accounts.swap_program.key(), crate::ID, RelayerError::SwapAccountNotAllowed);

    let base_ata_key = ctx.accounts.base_ata.key();
    let asset_ata_key = ctx.accounts.asset_ata.key();
    let auth_key = ctx.accounts.relayer_authority.key();

    let forbidden = [ctx.accounts.fee_vault.key(), ctx.accounts.relayer_config.key(), flow_key];

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
    let base_decimals = ctx.accounts.base_mint.decimals;
    let gross_in = ctx.accounts.flow.amount;

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

    let floor = {
        let price = read_offer_nav_price(
            &ctx.accounts.onre_offer.to_account_info(),
            &cfg.base_mint,
            &cfg.asset_mint,
            now_unix,
        )?;
        let gross_expected = oracle_expected_out(price, swap_in, direction, base_decimals, asset_decimals)?;
        apply_slippage_floor(gross_expected, cfg.max_slippage_bps)?
    };

    ctx.accounts.base_ata.reload()?;
    ctx.accounts.asset_ata.reload()?;
    let (in_before, out_before) = in_out(deposit, ctx.accounts.base_ata.amount, ctx.accounts.asset_ata.amount);
    require!(in_before >= swap_in, RelayerError::ZeroAmountFlow);

    // Clear any pre-existing delegate before the swap so stale residue can't
    // DoS the post-CPI pristine-ATA assert. A delegate the CPI introduces
    // afterward is still rejected by that (unchanged) strict assert.
    let token_program_info = ctx.accounts.token_program.to_account_info();
    let relayer_authority_info = ctx.accounts.relayer_authority.to_account_info();
    revoke_relayer_delegate(&token_program_info, &ctx.accounts.base_ata.to_account_info(), &relayer_authority_info, authority_bump)?;
    revoke_relayer_delegate(&token_program_info, &ctx.accounts.asset_ata.to_account_info(), &relayer_authority_info, authority_bump)?;

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

    // relayer_authority signs the swap CPI; snapshot its lamports/owner/data
    // to assert (post-CPI) the router didn't drain or reassign the PDA.
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
        let (net, fee) = ctx.accounts.relayer_config.apply_deposit_fee(out_received)?;
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
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = base_mint,
        has_one = asset_mint,
        has_one = fee_vault,
    )]
    pub relayer_config: Box<Account<'info, RelayerConfig>>,

    /// CHECK: PDA seeds enforce identity; signs the Approve, fee transfer,
    /// and swap CPI. Reach bounded by the post-CPI ATA assertions.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
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

    /// Fee destination — always denominated in the asset (ONyc) token.
    #[account(mut, token::mint = asset_mint, token::token_program = token_program)]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: validated transitively via the flow PDA seed binding.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [Flow::seed(flow.direction), ntt_inbox_item.key().as_ref()],
        bump = flow.bump,
    )]
    pub flow: Box<Account<'info, Flow>>,

    /// CHECK: handler pins this to relayer_config.price_oracle and validates
    /// it as the OnRe Offer PDA via read_offer_nav_price.
    pub onre_offer: UncheckedAccount<'info>,

    /// CHECK: router-agnostic. Safety from the NAV floor + bounded delegation,
    /// not program identity.
    pub swap_program: UncheckedAccount<'info>,

    /// CHECK: SPL delegate the router spends from in_ata. Pass
    /// `relayer_authority` as a sentinel for owner-signed routers (OnRe).
    pub swap_delegate: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
