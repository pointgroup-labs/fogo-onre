use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_INBOUND_SEED, FOGO_WORMHOLE_CHAIN_ID, NTT_PROGRAM_ID, NTT_TRANSFER_LOCK_IX,
    RELAYER_SEED, SPL_TOKEN_APPROVE_IX_TAG,
};
use crate::cpi::invoke_relayer_signed;
use crate::error::RelayerError;
use crate::events::OnycLocked;
use crate::ntt::{derive_session_authority, NttTransferArgs};
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// Lock the flow's ONyc via Wormhole NTT, sending bONyc back to
/// `flow.fogo_sender`. Permissionless; closing the PDA returns rent and
/// blocks replay.
///
/// ONyc is canonical on Solana, so the NTT manager runs in **Locking**
/// mode (transfer to NTT custody, not burn); the FOGO side mints/burns
/// wrapped bONyc.
///
/// `transfer_lock` requires the caller to first SPL-`Approve` the NTT
/// session-authority PDA as delegate on `onyc_ata`, so we issue that
/// approval (signed by the relayer authority PDA) before forwarding.
pub fn handler<'info>(ctx: Context<'info, LockOnyc<'info>>) -> Result<()> {
    let flow = &mut ctx.accounts.inflight_flow;
    require!(
        flow.status == FlowStatus::Swapped,
        RelayerError::FlowStatusMismatch
    );

    let amount = flow.amount;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    let recipient = flow.fogo_sender;

    let transfer_args = NttTransferArgs {
        amount,
        recipient_chain: FOGO_WORMHOLE_CHAIN_ID,
        recipient_address: recipient,
        should_queue: false,
    };

    // NTT binds session-authority to a hash of the transfer args; recompute
    // locally so we can pre-approve the right delegate.
    let (session_authority, _) =
        derive_session_authority(&ctx.accounts.relayer_authority.key(), &transfer_args);

    let bump = [ctx.accounts.relayer_config.relayer_authority_bump];
    let signer_seeds: &[&[u8]] = &[RELAYER_SEED, &bump];

    let approve_ix = instruction::Instruction {
        program_id: ctx.accounts.token_program.key(),
        accounts: vec![
            AccountMeta::new(ctx.accounts.onyc_ata.key(), false),
            AccountMeta::new_readonly(session_authority, false),
            AccountMeta::new_readonly(ctx.accounts.relayer_authority.key(), true),
        ],
        data: {
            // SPL Approve: tag(1) + amount(u64 LE)
            let mut d = Vec::with_capacity(9);
            d.push(SPL_TOKEN_APPROVE_IX_TAG);
            d.extend_from_slice(&amount.to_le_bytes());
            d
        },
    };

    // Locate session_authority in remaining_accounts so the runtime can
    // resolve the approve ix's account refs.
    let session_auth_info = ctx
        .remaining_accounts
        .iter()
        .find(|a| a.key() == session_authority)
        .ok_or(RelayerError::MissingSessionAuthority)?;

    invoke_signed(
        &approve_ix,
        &[
            ctx.accounts.onyc_ata.to_account_info(),
            session_auth_info.to_account_info(),
            ctx.accounts.relayer_authority.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
        ],
        &[signer_seeds],
    )?;

    invoke_relayer_signed(
        NTT_PROGRAM_ID,
        &NTT_TRANSFER_LOCK_IX,
        &transfer_args,
        ctx.remaining_accounts,
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
    )?;

    emit!(OnycLocked {
        flow: ctx.accounts.inflight_flow.key(),
        gateway_claim: ctx.accounts.gateway_claim.key(),
        fogo_sender: recipient,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct LockOnyc<'info> {
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

    /// CHECK: seed material only; validated transitively via the flow PDA.
    pub gateway_claim: UncheckedAccount<'info>,

    /// `close = rent_destination` blocks any second `lock_onyc` against this flow.
    #[account(
        mut,
        close = rent_destination,
        seeds = [FLOW_INBOUND_SEED, gateway_claim.key().as_ref()],
        bump = inflight_flow.bump,
    )]
    pub inflight_flow: Account<'info, Flow>,

    /// CHECK: pinned to the flow PDA's stored `payer`; receives rent refund.
    #[account(mut, address = inflight_flow.payer)]
    pub rent_destination: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}
