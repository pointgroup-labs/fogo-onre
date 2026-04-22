use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{
    CONFIG_SEED, FLOW_INBOUND_SEED, GATEWAY_COMPLETE_TRANSFER_IX, GATEWAY_PROGRAM_ID,
    REDEEMER_SEED, RELAYER_SEED, WORMHOLE_CORE_BRIDGE_ID,
};
use crate::cpi::invoke_relayer_signed_with_redeemer;
use crate::error::RelayerError;
use crate::events::UsdcClaimed;
use crate::state::{Flow, FlowStatus, RelayerConfig};
use crate::vaa::parse_fogo_sender_from_posted_vaa;

// TB `CompleteWrappedWithPayload` reads its VAA + creates the claim PDA
// *positionally* from `remaining_accounts`. We MUST pin the named
// `posted_vaa` / `gateway_claim` accounts to the same slots — otherwise
// a caller could pass VAA_A positionally (so TB mints VAA_A's USDC) but
// VAA_B as `posted_vaa` (so we parse Bob's wallet as `fogo_sender` and
// `lock_onyc` later ships bONyc to Bob instead of Alice).
//
// Source: wormhole token_bridge `complete_transfer.rs`,
// `CompleteWrappedWithPayload` accounts struct.

const TB_IDX_POSTED_VAA: usize = 2;
const TB_IDX_GATEWAY_CLAIM: usize = 3;
/// SDK helper supplies 17 entries; we only assert on what we read.
const TB_ACCOUNTS_MIN_LEN: usize = TB_IDX_GATEWAY_CLAIM + 1;

/// Claim incoming USDC from Wormhole Gateway and create the inbound `Flow`
/// receipt binding the eventual ONyc return to the originating FOGO wallet.
///
/// Permissionless. Safety:
/// - `fogo_sender` is parsed from the guardian-signed posted-VAA, not a caller arg.
/// - Flow PDA is seeded by the Gateway claim account (CPI-created, unforgeable).
/// - `init` blocks double-claims.
///
/// ## Two-stage token flow
///
/// TB `CompleteWrappedWithPayload` requires `redeemer.key == to.owner`. We
/// use a short-lived intake ATA owned by the redeemer PDA as `to`, then
/// immediately sweep into `usdc_ata` (signed by the redeemer PDA) so the
/// rest of the pipeline operates on the long-lived ATA. The alternative —
/// unifying redeemer with relayer authority — would relocate every
/// long-lived ATA.
///
/// `remaining_accounts` is Gateway's full account list with the relayer
/// authority PDA appended for the CPI helper's signer flag.
pub fn handler<'info>(ctx: Context<'info, ClaimUsdc<'info>>) -> Result<()> {
    // See top-of-file block comment for the attack the position pinning prevents.
    require!(
        ctx.remaining_accounts.len() >= TB_ACCOUNTS_MIN_LEN,
        RelayerError::InvalidAccountSplit
    );
    require!(
        ctx.remaining_accounts[TB_IDX_POSTED_VAA].key() == ctx.accounts.posted_vaa.key(),
        RelayerError::PostedVaaMismatch
    );
    require!(
        ctx.remaining_accounts[TB_IDX_GATEWAY_CLAIM].key() == ctx.accounts.gateway_claim.key(),
        RelayerError::GatewayClaimMismatch
    );

    let vaa_data = ctx.accounts.posted_vaa.try_borrow_data()?;
    let fogo_sender = parse_fogo_sender_from_posted_vaa(&vaa_data)?;
    drop(vaa_data);

    let pre_intake_balance = ctx.accounts.redeemer_usdc_ata.amount;

    let redeemer_key = ctx.accounts.redeemer_authority.key();
    let redeemer_bump = ctx.bumps.redeemer_authority;

    invoke_relayer_signed_with_redeemer(
        GATEWAY_PROGRAM_ID,
        &GATEWAY_COMPLETE_TRANSFER_IX,
        &(),
        ctx.remaining_accounts,
        &ctx.accounts.relayer_authority.to_account_info(),
        ctx.accounts.relayer_config.relayer_authority_bump,
        redeemer_key,
        redeemer_bump,
    )?;

    ctx.accounts.redeemer_usdc_ata.reload()?;
    let amount = ctx
        .accounts
        .redeemer_usdc_ata
        .amount
        .checked_sub(pre_intake_balance)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    // Sweep into the long-lived ATA, signed by the redeemer PDA.
    let bump_arr = [redeemer_bump];
    let signer_seeds: &[&[&[u8]]] = &[&[REDEEMER_SEED, &bump_arr]];
    transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.redeemer_usdc_ata.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.usdc_ata.to_account_info(),
                authority: ctx.accounts.redeemer_authority.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    require!(amount > 0, RelayerError::ZeroAmountFlow);

    let flow_key = ctx.accounts.inflight_flow.key();

    let flow = &mut ctx.accounts.inflight_flow;
    flow.fogo_sender = fogo_sender;
    flow.status = FlowStatus::Claimed;
    flow.amount = amount;
    flow.payer = ctx.accounts.payer.key();
    flow.bump = ctx.bumps.inflight_flow;

    emit!(UsdcClaimed {
        flow: flow_key,
        gateway_claim: ctx.accounts.gateway_claim.key(),
        fogo_sender,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ClaimUsdc<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = relayer_config.bump,
        has_one = usdc_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED; no data stored.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    /// CHECK: PDA derived from REDEEMER_SEED; signs the TB CPI + post-CPI sweep.
    #[account(seeds = [REDEEMER_SEED], bump)]
    pub redeemer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// Long-lived destination of the claim; populated by the post-CPI sweep.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: InterfaceAccount<'info, TokenAccount>,

    /// Short-lived intake ATA — TB mints into it during the CPI; we sweep
    /// to `usdc_ata` in the same instruction.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = redeemer_authority,
        associated_token::token_program = token_program,
    )]
    pub redeemer_usdc_ata: InterfaceAccount<'info, TokenAccount>,

    /// `fogo_sender` is read from on-chain (guardian-signed) data, not args.
    /// CHECK: owner = Wormhole core bridge.
    #[account(owner = WORMHOLE_CORE_BRIDGE_ID)]
    pub posted_vaa: UncheckedAccount<'info>,

    /// Per-VAA Gateway claim PDA — its pubkey seeds the flow PDA.
    /// CHECK: validated by the Gateway CPI.
    pub gateway_claim: UncheckedAccount<'info>,

    /// `init` blocks double-claims against the same gateway claim PDA.
    #[account(
        init,
        payer = payer,
        space = 8 + Flow::INIT_SPACE,
        seeds = [FLOW_INBOUND_SEED, gateway_claim.key().as_ref()],
        bump,
    )]
    pub inflight_flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
