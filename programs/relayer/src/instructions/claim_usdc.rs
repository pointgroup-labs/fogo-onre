use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{
    allowed_intent_setters, CONFIG_SEED, FLOW_INBOUND_SEED, FOGO_WORMHOLE_CHAIN_ID, NTT_REDEEM_IX,
    NTT_RELEASE_INBOUND_UNLOCK_IX, NTT_USDC_PROGRAM_ID, RELAYER_SEED, USER_INBOX_SEED,
};
use crate::cpi::invoke_relayer_signed;
use crate::error::RelayerError;
use crate::events::Received;
use crate::ntt::{
    derive_inbox_item_pda_from_vtm, parse_fogo_sender_from_vtm,
    validate_ntt_redeem_release_accounts, InboxItem, NttRedeemArgs, NttReleaseInboundArgs,
    ReleaseStatus, TRANSCEIVER_MESSAGE_FROM_CHAIN_OFFSET,
};
use crate::state::{Direction, Flow, FlowStatus, RelayerConfig};

/// Skip-path validation when `inbox_item.release_status == Released`
/// (NTT v1 release_inbound is permissionless — Wormhole executor may
/// have already redeemed before our cranker landed). In the skip
/// branch we never invoke NTT, so the redeem CPI's seed-validation of
/// `inbox_item` against `transceiver_message` does not run. We
/// reproduce it here, plus an explicit owner pin: without it a cranker
/// could craft a system-owned account with the right shape and have
/// us sweep their pre-funded `user_inbox_ata`.
fn validate_skip_path_inbox_item(
    ntt_inbox_item: &AccountInfo,
    ntt_transceiver_message: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(
        *ntt_inbox_item.owner,
        NTT_USDC_PROGRAM_ID,
        RelayerError::InvalidInboxItem
    );

    let vtm_data = ntt_transceiver_message.try_borrow_data()?;

    // Skipped redeem CPI would have pinned origin to FOGO; re-enforce:
    // `from_chain` (offset 8, u16 LE) must equal FOGO.
    require!(
        vtm_data.len() >= TRANSCEIVER_MESSAGE_FROM_CHAIN_OFFSET + 2,
        RelayerError::InvalidTransceiverMessage
    );
    let from_chain = u16::from_le_bytes([
        vtm_data[TRANSCEIVER_MESSAGE_FROM_CHAIN_OFFSET],
        vtm_data[TRANSCEIVER_MESSAGE_FROM_CHAIN_OFFSET + 1],
    ]);
    require!(
        from_chain == FOGO_WORMHOLE_CHAIN_ID,
        RelayerError::WrongOriginChain
    );

    let (expected_inbox_item, _) = derive_inbox_item_pda_from_vtm(&NTT_USDC_PROGRAM_ID, &vtm_data)?;
    drop(vtm_data);
    require_keys_eq!(
        ntt_inbox_item.key(),
        expected_inbox_item,
        RelayerError::InboxItemMismatch
    );
    Ok(())
}

/// Redeem inbound USDC.s from FOGO via NTT and create the inbound `Flow`
/// receipt binding the eventual return leg to the originating FOGO wallet.
///
/// Permissionless. Safety chain (cranker-controlled `user_wallet`):
/// - VAA recipient is `pda([USER_INBOX_SEED, user_wallet])`.
/// - NTT release pins `recipient_ata.authority == inbox_item.recipient_address`,
///   so `user_inbox_ata` is forced to the ATA of the PDA the user signed for.
/// - We re-derive that PDA from `user_wallet` and require equality.
/// - `NttManagerMessage.sender == intent_transfer` setter PDA: rejects
///   direct (non-intent) NTT bridges to the same recipient PDA.
/// - Sweep is exactly `inbox_item.amount` (per-VAA scoping handles
///   concurrent in-flight deposits from the same user).
///
/// `remaining_accounts` = redeem accounts ++ release accounts;
/// `redeem_accounts_len` is the split point.
pub fn handler<'info>(
    ctx: Context<'info, ClaimUsdc<'info>>,
    redeem_accounts_len: u8,
) -> Result<()> {
    let fogo_sender_raw = parse_fogo_sender_from_vtm(&ctx.accounts.ntt_transceiver_message)?;

    // Pin VAA's NTT sender to the permanent {OnRe, Fogo} intent setter
    // allowlist. Any other sender is a non-intent path and must not
    // deposit here. Keeping Fogo's setter preserves deposit switch-back.
    let allowed = allowed_intent_setters();
    require!(
        allowed.iter().any(|s| s.to_bytes() == fogo_sender_raw),
        RelayerError::UnexpectedFogoSender
    );

    // `try_load(..).ok()` distinguishes "fresh / wrong shape" (run full
    // CPI chain) from "valid Released InboxItem" (skip both CPIs).
    let pre_inbox = InboxItem::try_load(&ctx.accounts.ntt_inbox_item).ok();
    let inbox_already_released = matches!(
        pre_inbox.as_ref().map(|i| &i.release_status),
        Some(ReleaseStatus::Released)
    );
    if inbox_already_released {
        validate_skip_path_inbox_item(
            &ctx.accounts.ntt_inbox_item,
            &ctx.accounts.ntt_transceiver_message,
        )?;
    }

    let split = redeem_accounts_len as usize;
    let total = ctx.remaining_accounts.len();
    require!(
        split > 0 && split < total,
        RelayerError::InvalidAccountSplit
    );
    let (redeem_accs, release_accs) = ctx.remaining_accounts.split_at(split);

    validate_ntt_redeem_release_accounts(
        redeem_accs,
        release_accs,
        &NTT_USDC_PROGRAM_ID,
        ctx.accounts.ntt_transceiver_message.key(),
        ctx.accounts.ntt_inbox_item.key(),
        ctx.accounts.user_inbox_ata.key(),
    )?;

    let bump = ctx.accounts.relayer_config.relayer_authority_bump;
    let authority = ctx.accounts.relayer_authority.to_account_info();

    if !inbox_already_released {
        invoke_relayer_signed(
            NTT_USDC_PROGRAM_ID,
            &NTT_REDEEM_IX,
            &NttRedeemArgs {},
            redeem_accs,
            Some(&authority),
            bump,
        )?;

        invoke_relayer_signed(
            NTT_USDC_PROGRAM_ID,
            &NTT_RELEASE_INBOUND_UNLOCK_IX,
            &NttReleaseInboundArgs {
                revert_on_delay: false,
            },
            release_accs,
            Some(&authority),
            bump,
        )?;
    }

    // Skip path bypasses NTT's recipient_address == ATA-authority check;
    // assert it here so both branches enforce the recipient binding.
    let inbox = InboxItem::try_load(&ctx.accounts.ntt_inbox_item)?;
    require_keys_eq!(
        inbox.recipient_address,
        ctx.accounts.user_inbox_authority.key(),
        RelayerError::UserInboxAuthorityMismatch
    );
    // Trust `inbox_item.amount` as canonical per-VAA: a pre/post balance
    // delta is fragile under dust, concurrent VAAs, and the skip branch.
    let amount = inbox.amount;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    ctx.accounts.user_inbox_ata.reload()?;
    require!(
        ctx.accounts.user_inbox_ata.amount >= amount,
        RelayerError::InsufficientInboxBalance
    );

    // Sweep this VAA's exact recorded amount; the inbox PDA may keep a
    // non-zero post-balance (dust/concurrent VAAs) without corrupting us.
    let user_wallet_key = ctx.accounts.user_wallet.key();
    let inbox_bump = ctx.bumps.user_inbox_authority;
    let inbox_bump_arr = [inbox_bump];
    let inbox_seeds: &[&[u8]] = &[USER_INBOX_SEED, user_wallet_key.as_ref(), &inbox_bump_arr];
    transfer_checked(
        CpiContext::new_with_signer(
            *ctx.accounts.token_program.key,
            TransferChecked {
                from: ctx.accounts.user_inbox_ata.to_account_info(),
                mint: ctx.accounts.base_mint.to_account_info(),
                to: ctx.accounts.base_ata.to_account_info(),
                authority: ctx.accounts.user_inbox_authority.to_account_info(),
            },
            &[inbox_seeds],
        ),
        amount,
        ctx.accounts.base_mint.decimals,
    )?;

    let flow_key = ctx.accounts.inflight_flow.key();
    let user_wallet_bytes = user_wallet_key.to_bytes();

    let flow = &mut ctx.accounts.inflight_flow;
    flow.recipient = user_wallet_bytes;
    flow.status = FlowStatus::Received;
    flow.amount = amount;
    flow.payer = ctx.accounts.payer.key();
    flow.bump = ctx.bumps.inflight_flow;

    emit!(Received {
        flow: flow_key,
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        recipient: user_wallet_bytes,
        direction: Direction::Deposit,
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
        has_one = base_mint,
    )]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub base_mint: InterfaceAccount<'info, Mint>,

    /// Sweep destination — long-lived relayer-authority USDC ATA.
    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub base_ata: InterfaceAccount<'info, TokenAccount>,

    /// Originating FOGO wallet (Solana keys are chain-agnostic).
    /// Pinned via `user_inbox_authority` PDA derivation + NTT release
    /// ATA-authority check. See handler doc.
    /// CHECK: see safety chain in handler doc.
    pub user_wallet: UncheckedAccount<'info>,

    /// CHECK: PDA-derived; owns and signs sweeps from `user_inbox_ata`.
    #[account(
        seeds = [USER_INBOX_SEED, user_wallet.key().as_ref()],
        bump,
    )]
    pub user_inbox_authority: UncheckedAccount<'info>,

    /// NTT release_inbound deposits here; sweep moves exactly
    /// `flow.amount` to `usdc_ata`. Not `init_if_needed`: FOGO
    /// `bridge_ntt_tokens` arg `pay_destination_ata_rent: true` makes
    /// the executor create the ATA on first delivery.
    #[account(
        mut,
        associated_token::mint = base_mint,
        associated_token::authority = user_inbox_authority,
        associated_token::token_program = token_program,
    )]
    pub user_inbox_ata: InterfaceAccount<'info, TokenAccount>,

    /// No `#[account(owner = ...)]` here: on a fresh claim NTT redeem
    /// creates this account, so a pre-handler owner constraint would
    /// fail every first-time claim. The owner check runs in
    /// `validate_skip_path_inbox_item` — the only path where forgery is
    /// possible (no NTT CPI runs).
    /// CHECK: conditional owner + discriminator/recipient checks in handler.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    /// CHECK: owner pin + discriminator + offset checks in handler.
    #[account(owner = NTT_USDC_PROGRAM_ID)]
    pub ntt_transceiver_message: UncheckedAccount<'info>,

    /// `init` blocks double-claims against the same inbox item.
    #[account(
        init,
        payer = payer,
        space = 8 + Flow::INIT_SPACE,
        seeds = [FLOW_INBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump,
    )]
    pub inflight_flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
