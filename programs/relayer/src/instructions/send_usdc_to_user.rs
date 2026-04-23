use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, FOGO_WORMHOLE_CHAIN_ID, GATEWAY_PROGRAM_ID,
    GATEWAY_TRANSFER_OUT_IX, REDEMPTION_TRACKER_SEED, RELAYER_SEED, SENDER_SEED,
};
use crate::cpi::invoke_relayer_signed_with_sender;
use crate::error::RelayerError;
use crate::events::UsdcSentToUser;
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// TB `authority_signer` PDA — burn authority on `from_token_account` for
/// outbound wrapped transfers; the caller must `Approve` it as delegate first.
const TB_AUTHORITY_SIGNER_SEED: &[u8] = b"authority_signer";

/// Layout MUST match upstream
/// `solana/modules/token_bridge/program/src/api/transfer.rs::TransferWrappedWithPayloadData`.
/// `cpi_program_id` was added in a later TB revision and is required even for
/// plain transfers — Borsh fails with `Unexpected length of input` if missing.
/// Setting it to `Some(crate::ID)` binds TB's expected `sender` PDA to
/// `["sender"]` under crate::ID, which the relayer can sign for.
#[derive(AnchorSerialize, AnchorDeserialize)]
struct GatewayTransferArgs {
    nonce: u32,
    amount: u64,
    target_address: [u8; 32],
    target_chain: u16,
    payload: Vec<u8>,
    cpi_program_id: Option<Pubkey>,
}

/// Send the flow's USDC to the FOGO user recorded in the `Flow` PDA.
/// Permissionless — recipient is bound to `flow.fogo_sender`, replay is
/// blocked by closing the PDA.
pub fn handler<'info>(ctx: Context<'info, SendUsdcToUser<'info>>) -> Result<()> {
    let flow = &mut ctx.accounts.outflight_flow;
    require!(
        flow.status == FlowStatus::Swapped,
        RelayerError::FlowStatusMismatch
    );

    let amount = flow.amount;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    let recipient = flow.fogo_sender;

    // ["sender"] under crate::ID, NOT under Gateway — a Gateway-owned PDA
    // isn't signable from the relayer. Binding to our program ID is asserted
    // via `cpi_program_id` in the instruction data.
    let (sender_pda, sender_bump) =
        Pubkey::find_program_address(&[SENDER_SEED], &crate::ID);

    // TB's burn step calls `spl_token::burn(authority = authority_signer)`,
    // so the authority-PDA-owned ATA must first delegate `amount` of burn
    // rights to authority_signer. TB signs as authority_signer internally.
    let (auth_signer_pda, _) =
        Pubkey::find_program_address(&[TB_AUTHORITY_SIGNER_SEED], &GATEWAY_PROGRAM_ID);
    let auth_signer_info = ctx
        .remaining_accounts
        .iter()
        .find(|a| a.key == &auth_signer_pda)
        .ok_or(RelayerError::AuthorityNotInAccounts)?;

    let approve_ix = anchor_spl::token::spl_token::instruction::approve(
        &anchor_spl::token::spl_token::ID,
        &ctx.accounts.usdc_ata.key(),
        &auth_signer_pda,
        &ctx.accounts.relayer_authority.key(),
        &[],
        amount,
    )?;
    let auth_bump_arr = [ctx.accounts.relayer_config.relayer_authority_bump];
    let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump_arr];
    invoke_signed(
        &approve_ix,
        &[
            ctx.accounts.usdc_ata.to_account_info(),
            auth_signer_info.clone(),
            ctx.accounts.relayer_authority.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[auth_seeds],
    )?;

    invoke_relayer_signed_with_sender(
        GATEWAY_PROGRAM_ID,
        &GATEWAY_TRANSFER_OUT_IX,
        &GatewayTransferArgs {
            nonce: 0,
            amount,
            target_address: recipient,
            target_chain: FOGO_WORMHOLE_CHAIN_ID,
            payload: Vec::new(),
            cpi_program_id: Some(crate::ID),
        },
        ctx.remaining_accounts,
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
        sender_pda,
        sender_bump,
    )?;

    emit!(UsdcSentToUser {
        flow: ctx.accounts.outflight_flow.key(),
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        fogo_sender: recipient,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SendUsdcToUser<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = usdc_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: InterfaceAccount<'info, TokenAccount>,

    /// Same NTT inbox-item PDA used at `unlock_onyc` time.
    /// CHECK: seed material only; validated transitively via the flow PDA.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    /// Closing on success returns rent to the original payer and blocks replays.
    #[account(
        mut,
        close = rent_destination,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump = outflight_flow.bump,
    )]
    pub outflight_flow: Account<'info, Flow>,

    /// CHECK: validated against `outflight_flow.payer`.
    #[account(mut, address = outflight_flow.payer)]
    pub rent_destination: UncheckedAccount<'info>,

    /// Singleton redemption tracker slot — must NOT currently exist. Gating
    /// `send_usdc_to_user` on this closes the outflow race in the withdraw-
    /// chain delta math: while any `RedemptionTracker` is alive, a sibling
    /// flow may be mid-redemption with its pre-balance snapshot pinned
    /// against this very `usdc_ata`. A concurrent outflow here would poison
    /// that delta (`B.redeemed − A.amount` instead of `B.redeemed`),
    /// causing `BalanceUnderflow` or silent user under-credit.
    ///
    /// `SystemAccount` asserts `owner == system_program::ID`. Combined with
    /// the seed pinning, this passes iff the PDA either never existed or
    /// was closed (by `claim_redemption_usdc` / `cancel_redemption_onyc`)
    /// and fails when a redemption is mid-flight — exactly the invariant
    /// `claim_redemption_usdc`'s snapshot→reload math needs.
    ///
    /// Liveness note: already-`Swapped` flows wait on the pending redemption
    /// to complete. Stuck redemptions are covered by
    /// `cancel_redemption_onyc`. This is a deliberate correctness-over-
    /// latency trade.
    #[account(
        seeds = [REDEMPTION_TRACKER_SEED],
        bump,
    )]
    pub redemption_tracker: SystemAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
