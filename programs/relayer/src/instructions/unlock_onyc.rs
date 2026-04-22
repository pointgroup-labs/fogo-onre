use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CONFIG_SEED, FLOW_OUTBOUND_SEED, NTT_PROGRAM_ID, NTT_REDEEM_IX, NTT_RELEASE_INBOUND_UNLOCK_IX,
    RELAYER_SEED,
};
use crate::cpi::invoke_relayer_signed;
use crate::error::RelayerError;
use crate::events::OnycUnlocked;
use crate::ntt::{
    NttRedeemArgs, NttReleaseInboundArgs, TRANSCEIVER_MESSAGE_SENDER_OFFSET,
    VALIDATED_TRANSCEIVER_MESSAGE_DISC,
};
use crate::state::{Flow, FlowStatus, RelayerConfig};

// NTT's `redeem` / `release_inbound_unlock` consume accounts *positionally*.
// If upstream reorders its `#[derive(Accounts)]` fields, these constants
// MUST move in lockstep — otherwise the position-pinning checks would
// silently guard the wrong slots, re-opening the
// decouple-sender-from-recipient attack.
//
// Source: example-native-token-transfers `redeem.rs`, `release_inbound.rs`.

const REDEEM_ACCOUNTS_MIN_LEN: usize = 10;
const RELEASE_ACCOUNTS_MIN_LEN: usize = 8;

const REDEEM_IDX_TRANSCEIVER_MESSAGE: usize = 3;
const REDEEM_IDX_INBOX_ITEM: usize = 6;
const RELEASE_IDX_INBOX_ITEM: usize = 2;
const RELEASE_IDX_RECIPIENT_ATA: usize = 3;

/// Release ONyc from NTT custody for an inbound VAA from FOGO and create
/// the outbound `Flow` receipt binding the eventual USDC return to the
/// withdrawing FOGO user.
///
/// Permissionless. Safety:
/// - NTT `redeem` validates guardian sigs via `ValidatedTransceiverMessage`
///   (whose owner must equal the registered transceiver).
/// - `fogo_sender` is `NttManagerMessage.sender` parsed from on-chain
///   transceiver-message data; Anchor `owner = NTT_PROGRAM_ID` plus the
///   discriminator check reject impostors.
///
/// `remaining_accounts` = redeem accounts ++ release accounts;
/// `redeem_accounts_len` is the split point.
pub fn handler<'info>(
    ctx: Context<'info, UnlockOnyc<'info>>,
    redeem_accounts_len: u8,
) -> Result<()> {
    // `owner = NTT_PROGRAM_ID` pins the writer; disc check guards the offset.
    let data = ctx.accounts.ntt_transceiver_message.try_borrow_data()?;
    require!(
        data.len() >= TRANSCEIVER_MESSAGE_SENDER_OFFSET + 32,
        RelayerError::InvalidTransceiverMessage
    );
    require!(
        data[..8] == VALIDATED_TRANSCEIVER_MESSAGE_DISC,
        RelayerError::InvalidTransceiverMessage
    );
    let mut fogo_sender = [0u8; 32];
    fogo_sender.copy_from_slice(
        &data[TRANSCEIVER_MESSAGE_SENDER_OFFSET..TRANSCEIVER_MESSAGE_SENDER_OFFSET + 32],
    );
    require!(fogo_sender != [0u8; 32], RelayerError::ZeroFogoSender);
    drop(data);

    let split = redeem_accounts_len as usize;
    let total = ctx.remaining_accounts.len();
    require!(
        split > 0 && split < total,
        RelayerError::InvalidAccountSplit
    );
    let (redeem_accs, release_accs) = ctx.remaining_accounts.split_at(split);

    // See top-of-file block comment for the attack the position pinning prevents.
    require!(
        redeem_accs.len() >= REDEEM_ACCOUNTS_MIN_LEN
            && release_accs.len() >= RELEASE_ACCOUNTS_MIN_LEN,
        RelayerError::InvalidAccountSplit
    );
    require!(
        redeem_accs[REDEEM_IDX_TRANSCEIVER_MESSAGE].key()
            == ctx.accounts.ntt_transceiver_message.key(),
        RelayerError::TransceiverMessageMismatch
    );
    require!(
        redeem_accs[REDEEM_IDX_INBOX_ITEM].key() == ctx.accounts.ntt_inbox_item.key(),
        RelayerError::InboxItemMismatch
    );
    require!(
        release_accs[RELEASE_IDX_INBOX_ITEM].key() == ctx.accounts.ntt_inbox_item.key(),
        RelayerError::InboxItemMismatch
    );
    require!(
        release_accs[RELEASE_IDX_RECIPIENT_ATA].key() == ctx.accounts.onyc_ata.key(),
        RelayerError::RecipientAtaMismatch
    );

    let bump = ctx.accounts.relayer_config.relayer_authority_bump;
    let authority = ctx.accounts.relayer_authority.to_account_info();

    let pre_balance = ctx.accounts.onyc_ata.amount;

    invoke_relayer_signed(
        NTT_PROGRAM_ID,
        &NTT_REDEEM_IX,
        &NttRedeemArgs {},
        redeem_accs,
        &authority,
        bump,
    )?;

    invoke_relayer_signed(
        NTT_PROGRAM_ID,
        &NTT_RELEASE_INBOUND_UNLOCK_IX,
        &NttReleaseInboundArgs {
            revert_on_delay: false,
        },
        release_accs,
        &authority,
        bump,
    )?;

    // Delta = what this VAA released.
    ctx.accounts.onyc_ata.reload()?;
    let amount = ctx
        .accounts
        .onyc_ata
        .amount
        .checked_sub(pre_balance)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    let flow_key = ctx.accounts.outflight_flow.key();

    let flow = &mut ctx.accounts.outflight_flow;
    flow.fogo_sender = fogo_sender;
    flow.status = FlowStatus::Claimed;
    flow.amount = amount;
    flow.payer = ctx.accounts.payer.key();
    flow.bump = ctx.bumps.outflight_flow;

    emit!(OnycUnlocked {
        flow: flow_key,
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        fogo_sender,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct UnlockOnyc<'info> {
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

    /// Per-VAA NTT inbox-item PDA — its pubkey seeds the flow PDA.
    /// CHECK: validated by the NTT CPI.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    /// `fogo_sender` is parsed from this already-validated bytes. `owner`
    /// pins the writer to NTT (== transceiver in OnRe's deployment), so
    /// nothing outside NTT can have crafted this data.
    /// CHECK: owner + discriminator + offset checks in the handler.
    #[account(owner = NTT_PROGRAM_ID)]
    pub ntt_transceiver_message: UncheckedAccount<'info>,

    /// `init` blocks replay (same NTT inbox → same PDA → already exists).
    #[account(
        init,
        payer = payer,
        space = 8 + Flow::INIT_SPACE,
        seeds = [FLOW_OUTBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump,
    )]
    pub outflight_flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
