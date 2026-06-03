//! Route-agnostic inbound NTT receive.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, TransferChecked, transfer_checked};

use crate::{
    constants::{
        CONFIG_SEED, FOGO_WORMHOLE_CHAIN_ID, NTT_REDEEM_IX, NTT_RELEASE_INBOUND_UNLOCK_IX, RELAYER_SEED,
        USER_INBOX_SEED, allowed_intent_setters,
    },
    cpi::invoke_relayer_signed,
    error::RelayerError,
    events::Received,
    ntt::{
        InboxItem, NttRedeemArgs, NttReleaseInboundArgs, ReleaseStatus, TRANSCEIVER_MESSAGE_FROM_CHAIN_OFFSET,
        derive_inbox_item_pda_from_vtm, parse_fogo_sender_from_vtm, validate_ntt_redeem_release_accounts,
    },
    state::{Direction, Flow, FlowStatus, RelayerConfig, receive_ntt_program},
};

pub fn handler<'info>(
    ctx: Context<'info, Receive<'info>>,
    direction: Direction,
    redeem_accounts_len: u8,
) -> Result<()> {
    let ntt_program = receive_ntt_program(direction);

    require_keys_eq!(ctx.accounts.ntt_program.key(), ntt_program, RelayerError::BadNttProgram);
    require_keys_eq!(ctx.accounts.ntt_transceiver_message.owner.key(), ntt_program, RelayerError::BadNttProgram);

    let cfg = &ctx.accounts.relayer_config;
    let token_mint = match direction {
        Direction::Deposit => cfg.base_mint,
        Direction::Withdraw => cfg.asset_mint,
    };

    require_keys_eq!(ctx.accounts.recv_mint.key(), token_mint, RelayerError::BadReceiveMint);

    let fogo_sender_raw = parse_fogo_sender_from_vtm(&ctx.accounts.ntt_transceiver_message)?;

    // Pin the VAA's NTT sender to the {OnRe, Fogo} intent-setter allowlist;
    // any other sender is a non-intent path and must not receive.
    let allowed = allowed_intent_setters();
    require!(allowed.iter().any(|s| s.to_bytes() == fogo_sender_raw), RelayerError::UnexpectedFogoSender);

    let pre_inbox = InboxItem::try_load(&ctx.accounts.ntt_inbox_item).ok();
    let inbox_already_released = matches!(pre_inbox.as_ref().map(|i| &i.release_status), Some(ReleaseStatus::Released));
    if inbox_already_released {
        validate_skip_path_inbox_item(
            &ntt_program,
            &ctx.accounts.ntt_inbox_item,
            &ctx.accounts.ntt_transceiver_message,
        )?;
    }

    let split = redeem_accounts_len as usize;
    let total = ctx.remaining_accounts.len();
    require!(split > 0 && split < total, RelayerError::InvalidAccountSplit);
    let (redeem_accs, release_accs) = ctx.remaining_accounts.split_at(split);

    validate_ntt_redeem_release_accounts(
        redeem_accs,
        release_accs,
        &ntt_program,
        ctx.accounts.ntt_transceiver_message.key(),
        ctx.accounts.ntt_inbox_item.key(),
        ctx.accounts.user_inbox_ata.key(),
    )?;

    let bump = ctx.accounts.relayer_config.relayer_authority_bump;
    let authority = ctx.accounts.relayer_authority.to_account_info();

    if !inbox_already_released {
        invoke_relayer_signed(ntt_program, &NTT_REDEEM_IX, &NttRedeemArgs {}, redeem_accs, Some(&authority), bump)?;

        invoke_relayer_signed(
            ntt_program,
            &NTT_RELEASE_INBOUND_UNLOCK_IX,
            &NttReleaseInboundArgs { revert_on_delay: false },
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

    let amount = inbox.amount;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    ctx.accounts.user_inbox_ata.reload()?;
    require!(ctx.accounts.user_inbox_ata.amount >= amount, RelayerError::InsufficientInboxBalance);

    // Sweep exactly the recorded amount; the inbox may keep dust without
    // corrupting us.
    let user_wallet_key = ctx.accounts.user_wallet.key();
    let inbox_bump = ctx.bumps.user_inbox_authority;
    let inbox_seeds: &[&[u8]] = &[USER_INBOX_SEED, user_wallet_key.as_ref(), &[inbox_bump]];

    transfer_checked(
        CpiContext::new_with_signer(
            *ctx.accounts.token_program.key,
            TransferChecked {
                from: ctx.accounts.user_inbox_ata.to_account_info(),
                mint: ctx.accounts.recv_mint.to_account_info(),
                to: ctx.accounts.recv_ata.to_account_info(),
                authority: ctx.accounts.user_inbox_authority.to_account_info(),
            },
            &[inbox_seeds],
        ),
        amount,
        ctx.accounts.recv_mint.decimals,
    )?;

    let flow_key = ctx.accounts.flow.key();

    let flow = &mut ctx.accounts.flow;
    flow.recipient = user_wallet_key;
    flow.status = FlowStatus::Received;
    flow.direction = direction;
    flow.amount = amount;
    flow.payer = ctx.accounts.payer.key();
    flow.bump = ctx.bumps.flow;

    emit!(Received {
        flow: flow_key,
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        recipient: user_wallet_key,
        direction,
        amount,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(direction: Direction)]
pub struct Receive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = relayer_config.bump)]
    pub relayer_config: Account<'info, RelayerConfig>,

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    /// The received token's mint. Pinned in-handler to the direction-selected
    /// config mint (base for deposit, asset for withdraw).
    pub recv_mint: InterfaceAccount<'info, Mint>,

    /// Sweep destination — long-lived relayer-authority ATA for recv_mint.
    #[account(
        mut,
        associated_token::mint = recv_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub recv_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: see safety chain in handler doc.
    pub user_wallet: UncheckedAccount<'info>,

    /// CHECK: PDA-derived; owns and signs sweeps from user_inbox_ata.
    #[account(seeds = [USER_INBOX_SEED, user_wallet.key().as_ref()], bump)]
    pub user_inbox_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = recv_mint,
        associated_token::authority = user_inbox_authority,
        associated_token::token_program = token_program,
    )]
    pub user_inbox_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: conditional owner + discriminator/recipient checks in handler.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    /// CHECK: owner pinned in-handler to receive_ntt_program(direction).
    pub ntt_transceiver_message: UncheckedAccount<'info>,

    /// CHECK: asserted in-handler == receive_ntt_program(direction).
    pub ntt_program: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Flow::INIT_SPACE,
        seeds = [Flow::seed(direction), ntt_inbox_item.key().as_ref()],
        bump,
    )]
    pub flow: Account<'info, Flow>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Re-validate `inbox_item` on the skip path (already `Released`), where the
/// redeem CPI's seed-check against `transceiver_message` never runs. Pins the
/// owner too: without it a cranker could forge a system-owned look-alike and
/// have us sweep their pre-funded `user_inbox_ata`.
fn validate_skip_path_inbox_item(
    ntt_program: &Pubkey,
    ntt_inbox_item: &AccountInfo,
    ntt_transceiver_message: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(*ntt_inbox_item.owner, *ntt_program, RelayerError::InvalidInboxItem);

    let vtm_data = ntt_transceiver_message.try_borrow_data()?;
    require!(vtm_data.len() >= TRANSCEIVER_MESSAGE_FROM_CHAIN_OFFSET + 2, RelayerError::InvalidTransceiverMessage);
    let from_chain = u16::from_le_bytes([
        vtm_data[TRANSCEIVER_MESSAGE_FROM_CHAIN_OFFSET],
        vtm_data[TRANSCEIVER_MESSAGE_FROM_CHAIN_OFFSET + 1],
    ]);
    require!(from_chain == FOGO_WORMHOLE_CHAIN_ID, RelayerError::WrongOriginChain);

    let (expected_inbox_item, _) = derive_inbox_item_pda_from_vtm(ntt_program, &vtm_data)?;
    drop(vtm_data);
    require_keys_eq!(ntt_inbox_item.key(), expected_inbox_item, RelayerError::InboxItemMismatch);
    Ok(())
}
