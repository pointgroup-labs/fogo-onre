use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

use crate::constants::{
    CONFIG_SEED, FLOW_INBOUND_SEED, FOGO_WORMHOLE_CHAIN_ID, INTENT_TRANSFER_PROGRAM_ID,
    INTENT_TRANSFER_SETTER_SEED, NTT_REDEEM_IX, NTT_RELEASE_INBOUND_UNLOCK_IX,
    NTT_USDC_PROGRAM_ID, REDEMPTION_TRACKER_SEED, RELAYER_SEED, USER_INBOX_SEED,
};
use crate::cpi::invoke_relayer_signed;
use crate::error::RelayerError;
use crate::events::UsdcClaimed;
use crate::ntt::{
    derive_inbox_item_pda_from_vtm, derive_ntt_inbox_rate_limit, derive_ntt_peer, InboxItem,
    NttRedeemArgs, NttReleaseInboundArgs, ReleaseStatus, TRANSCEIVER_MESSAGE_SENDER_OFFSET,
    VALIDATED_TRANSCEIVER_MESSAGE_DISC,
};
use crate::state::{Flow, FlowStatus, RelayerConfig};

// Mirrors `unlock_onyc`. NTT consumes accounts positionally; if upstream
// reorders its `#[derive(Accounts)]` these constants MUST move in lockstep.

const REDEEM_ACCOUNTS_MIN_LEN: usize = 10;
const RELEASE_ACCOUNTS_MIN_LEN: usize = 8;

const REDEEM_IDX_PEER: usize = 2;
const REDEEM_IDX_TRANSCEIVER_MESSAGE: usize = 3;
const REDEEM_IDX_INBOX_ITEM: usize = 6;
const REDEEM_IDX_INBOX_RATE_LIMIT: usize = 7;
const RELEASE_IDX_INBOX_ITEM: usize = 2;
const RELEASE_IDX_RECIPIENT_ATA: usize = 3;

/// Redeem inbound USDC.s from FOGO via NTT and create the inbound `Flow`
/// receipt binding the eventual ONyc → ONyc return to the originating
/// FOGO wallet.
///
/// Permissionless. Safety chain (cranker-controlled `user_wallet`):
/// - The webapp signs an intent whose `recipient_address` is
///   `pda([USER_INBOX_SEED, user_wallet], program_id)`. The VAA carries
///   that PDA as the recipient.
/// - NTT `release_inbound_unlock` enforces
///   `release_accs[RECIPIENT_ATA].associated_token::authority ==
///   inbox_item.recipient_address`. So `user_inbox_ata` is *forced* to
///   be the ATA of the PDA the user signed for.
/// - We re-derive that PDA from `user_wallet` and `require_keys_eq!` it
///   against `user_inbox_authority`. A cranker passing the wrong
///   `user_wallet` would have to also pass an inbox ATA whose authority
///   matches both the PDA derivation AND the in-flight VAA — which
///   collapses to: only the originating wallet's `user_wallet` works.
/// - `NttManagerMessage.sender` is required to equal `intent_transfer`'s
///   singleton setter PDA. Direct (non-intent) NTT bridges to the same
///   recipient PDA are rejected; the only valid origination is the user
///   signing an intent in the webapp.
/// - Sweep: PDA-signed SPL transfer of exactly `amount` (the per-VAA
///   delta on `user_inbox_ata`) into the relayer-authority USDC ATA.
///   Per-VAA scoping handles concurrent in-flight deposits from the
///   same user — the next `claim_usdc` sees the delta from *its* VAA's
///   release, not full balance.
/// - `flow.fogo_sender = user_wallet` so the return-leg `lock_onyc`
///   bridges ONyc back to the originating wallet.
///
/// `remaining_accounts` = redeem accounts ++ release accounts;
/// `redeem_accounts_len` is the split point.
pub fn handler<'info>(
    ctx: Context<'info, ClaimUsdc<'info>>,
    redeem_accounts_len: u8,
) -> Result<()> {
    let data = ctx.accounts.ntt_transceiver_message.try_borrow_data()?;
    require!(
        data.len() >= TRANSCEIVER_MESSAGE_SENDER_OFFSET + 32,
        RelayerError::InvalidTransceiverMessage
    );
    require!(
        data[..8] == VALIDATED_TRANSCEIVER_MESSAGE_DISC,
        RelayerError::InvalidTransceiverMessage
    );
    let mut fogo_sender_raw = [0u8; 32];
    fogo_sender_raw.copy_from_slice(
        &data[TRANSCEIVER_MESSAGE_SENDER_OFFSET..TRANSCEIVER_MESSAGE_SENDER_OFFSET + 32],
    );
    require!(fogo_sender_raw != [0u8; 32], RelayerError::ZeroFogoSender);
    drop(data);

    // Pin the VAA's NTT sender to intent_transfer's singleton setter
    // PDA. The setter is the from-ATA owner inside `bridge_ntt_tokens`,
    // so every intent-driven bridge surfaces this exact pubkey as
    // `NttManagerMessage.sender`. Anything else is a non-intent path
    // and must not deposit through `claim_usdc`.
    let (expected_setter, _) = Pubkey::find_program_address(
        &[INTENT_TRANSFER_SETTER_SEED],
        &INTENT_TRANSFER_PROGRAM_ID,
    );
    require!(
        fogo_sender_raw == expected_setter.to_bytes(),
        RelayerError::UnexpectedFogoSender
    );

    // Race-tolerance: NTT v1 release_inbound_unlock is permissionless.
    // The Wormhole executor (or anyone) may have already redeemed +
    // released this VAA into `user_inbox_ata` before our cranker landed
    // a tx. If we re-issue the redeem CPI in that case, NTT errors on
    // the duplicate vote, the whole tx aborts, and the funds sit in the
    // inbox forever with no `Flow` recorded. Detect the
    // `InboxItem.release_status == Released` state up front and skip
    // both NTT CPIs when it's already there.
    //
    // Pre-release detection requires the inbox_item account to already
    // exist (NTT redeem creates it). If it doesn't exist or has the
    // wrong shape, we treat that as "fresh" and run the full chain.
    //
    // SECURITY: this detection runs BEFORE the structural account-array
    // checks below so that the owner-guard for the skip path fires at
    // the earliest possible point. The non-skip branch inherits owner
    // validation from the NTT redeem CPI (NTT creates and writes the
    // account itself); the skip branch never invokes NTT, so without
    // the explicit owner check below a malicious cranker could craft a
    // system-program-owned account at any address they control, write
    // the right discriminator + amount + Released bytes, pre-fund their
    // own user_inbox_ata with USDC, and have us sweep that USDC into
    // custody as a phantom deposit attributed to their wallet —
    // bypassing intent_transfer's fee path on FOGO entirely.
    //
    // `try_load(..).ok()` distinguishes "fresh / wrong shape" (run the
    // full CPI chain) from "valid InboxItem with Released status"
    // (skip both CPIs).
    let pre_inbox = InboxItem::try_load(&ctx.accounts.ntt_inbox_item).ok();
    let inbox_already_released = matches!(
        pre_inbox.as_ref().map(|i| &i.release_status),
        Some(ReleaseStatus::Released)
    );
    if inbox_already_released {
        require_keys_eq!(
            *ctx.accounts.ntt_inbox_item.owner,
            NTT_USDC_PROGRAM_ID,
            RelayerError::InvalidInboxItem
        );

        // SECURITY: bind the supplied VTM to the supplied InboxItem on the
        // skip path. NTT redeem normally creates the InboxItem at a PDA
        // seeded by `keccak256(from_chain_BE || NttManagerMessage_wire)`
        // — that's the cryptographic link between VTM and InboxItem. The
        // skip path bypasses that CPI, so without re-deriving here a
        // cranker could pair a real intent_transfer-originated VTM with
        // an unrelated already-released InboxItem (e.g. one created by a
        // *direct* NTT bridge to a per-user PDA, bypassing
        // intent_transfer's fee path on FOGO). The intent_transfer
        // sender check above would still pass against the borrowed VTM,
        // and the recipient check below would still pass against the
        // attacker-controlled InboxItem — but the funds were never
        // intent-routed. Re-deriving the InboxItem PDA from the VTM
        // bytes closes that gap by reproducing exactly what NTT redeem's
        // Anchor seed constraint would have enforced on the non-skip
        // path.
        let vtm_data = ctx.accounts.ntt_transceiver_message.try_borrow_data()?;
        let (expected_inbox_item, _) =
            derive_inbox_item_pda_from_vtm(&NTT_USDC_PROGRAM_ID, &vtm_data)?;
        drop(vtm_data);
        require_keys_eq!(
            ctx.accounts.ntt_inbox_item.key(),
            expected_inbox_item,
            RelayerError::InboxItemMismatch
        );
    }

    let split = redeem_accounts_len as usize;
    let total = ctx.remaining_accounts.len();
    require!(
        split > 0 && split < total,
        RelayerError::InvalidAccountSplit
    );
    let (redeem_accs, release_accs) = ctx.remaining_accounts.split_at(split);

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
    // Pin the inbound origin to FOGO. Without this, a future non-FOGO peer
    // registration on the NTT manager would let foreign-chain VAAs create
    // Flow PDAs that the outbound legs blindly bridge back to FOGO.
    let (expected_peer, _) = derive_ntt_peer(&NTT_USDC_PROGRAM_ID, FOGO_WORMHOLE_CHAIN_ID);
    let (expected_inbox_rl, _) =
        derive_ntt_inbox_rate_limit(&NTT_USDC_PROGRAM_ID, FOGO_WORMHOLE_CHAIN_ID);
    require_keys_eq!(
        redeem_accs[REDEEM_IDX_PEER].key(),
        expected_peer,
        RelayerError::WrongOriginChain
    );
    require_keys_eq!(
        redeem_accs[REDEEM_IDX_INBOX_RATE_LIMIT].key(),
        expected_inbox_rl,
        RelayerError::WrongOriginChain
    );
    require!(
        release_accs[RELEASE_IDX_INBOX_ITEM].key() == ctx.accounts.ntt_inbox_item.key(),
        RelayerError::InboxItemMismatch
    );
    // Release destination is now the per-user inbox ATA — the relayer
    // authority ATA is downstream of the sweep.
    require!(
        release_accs[RELEASE_IDX_RECIPIENT_ATA].key() == ctx.accounts.user_inbox_ata.key(),
        RelayerError::RecipientAtaMismatch
    );

    let bump = ctx.accounts.relayer_config.relayer_authority_bump;
    let authority = ctx.accounts.relayer_authority.to_account_info();

    if !inbox_already_released {
        invoke_relayer_signed(
            NTT_USDC_PROGRAM_ID,
            &NTT_REDEEM_IX,
            &NttRedeemArgs {},
            redeem_accs,
            &authority,
            bump,
        )?;

        invoke_relayer_signed(
            NTT_USDC_PROGRAM_ID,
            &NTT_RELEASE_INBOUND_UNLOCK_IX,
            &NttReleaseInboundArgs {
                revert_on_delay: false,
            },
            release_accs,
            &authority,
            bump,
        )?;
    }
    // (owner-guard for the skip path was hoisted above the
    // structural account-array checks — see the SECURITY note next to
    // the `inbox_already_released` detection.)

    // Trust the NTT-recorded inbox_item.amount (post-detrim, native
    // token decimals) as the canonical per-VAA amount. The previous
    // pre/post-balance delta strategy was fragile under two real
    // scenarios:
    //   1. Anyone can dust the open PDA-owned inbox ATA — a delta
    //      sweep would either miss the dust or attribute it to the
    //      next VAA's flow, polluting accounting.
    //   2. Multiple in-flight VAAs for the same user share the inbox
    //      ATA. With the executor-already-released branch above, we no
    //      longer hold a strict pre/post window around our own release
    //      CPI; the delta is meaningless across interleaved deliveries.
    // Reading `amount` from the inbox_item PDA directly avoids both
    // failure modes. Each VAA's claim_usdc sweeps exactly its own
    // recorded amount; cross-VAA balance leftovers stay in the inbox
    // until their own claim_usdc runs.
    // Reload via typed deserializer — covers both paths uniformly:
    //   - skip path: `pre_inbox` is Some, but a fresh re-load is no
    //     more expensive and keeps the borrow scope local.
    //   - non-skip path: pre_inbox was None (or NotApproved); the NTT
    //     CPIs above just created/wrote the account, so a fresh load
    //     is the only correct read.
    // Defense in depth: the per-user PDA chain also enforces the
    // recipient binding via the NTT release CPI's own
    // `recipient_address == ATA authority` check, but in the
    // `inbox_already_released` skip path that CPI doesn't run.
    // Asserting it explicitly here covers both branches and removes
    // any implicit reliance on NTT internals.
    let inbox = InboxItem::try_load(&ctx.accounts.ntt_inbox_item)?;
    require_keys_eq!(
        inbox.recipient_address,
        ctx.accounts.user_inbox_authority.key(),
        RelayerError::UserInboxAuthorityMismatch
    );
    let amount = inbox.amount;
    require!(amount > 0, RelayerError::ZeroAmountFlow);

    ctx.accounts.user_inbox_ata.reload()?;
    require!(
        ctx.accounts.user_inbox_ata.amount >= amount,
        RelayerError::InsufficientInboxBalance
    );

    // Sweep this VAA's exact NTT-recorded amount into relayer custody.
    // Signed by the per-user inbox PDA (it owns the inbox ATA). The
    // inbox PDA may retain a non-zero post-balance: dust deposits,
    // residue from concurrent in-flight VAAs whose claim_usdc hasn't
    // run yet, or executor over-funding. None of those corrupt this
    // flow's accounting.
    let user_wallet_key = ctx.accounts.user_wallet.key();
    let inbox_bump = ctx.bumps.user_inbox_authority;
    let inbox_bump_arr = [inbox_bump];
    let inbox_seeds: &[&[u8]] = &[USER_INBOX_SEED, user_wallet_key.as_ref(), &inbox_bump_arr];
    transfer_checked(
        CpiContext::new_with_signer(
            *ctx.accounts.token_program.key,
            TransferChecked {
                from: ctx.accounts.user_inbox_ata.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.usdc_ata.to_account_info(),
                authority: ctx.accounts.user_inbox_authority.to_account_info(),
            },
            &[inbox_seeds],
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    let flow_key = ctx.accounts.inflight_flow.key();
    let user_wallet_bytes = user_wallet_key.to_bytes();

    let flow = &mut ctx.accounts.inflight_flow;
    flow.fogo_sender = user_wallet_bytes;
    flow.status = FlowStatus::Claimed;
    flow.amount = amount;
    flow.payer = ctx.accounts.payer.key();
    flow.bump = ctx.bumps.inflight_flow;

    emit!(UsdcClaimed {
        flow: flow_key,
        ntt_inbox_item: ctx.accounts.ntt_inbox_item.key(),
        fogo_sender: user_wallet_bytes,
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

    /// CHECK: PDA derived from RELAYER_SEED.
    #[account(seeds = [RELAYER_SEED], bump = relayer_config.relayer_authority_bump)]
    pub relayer_authority: UncheckedAccount<'info>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    /// Sweep destination — long-lived relayer-authority USDC ATA.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer_authority,
        associated_token::token_program = token_program,
    )]
    pub usdc_ata: InterfaceAccount<'info, TokenAccount>,

    /// Originating FOGO wallet (same pubkey on Solana — keys are chain-agnostic).
    /// Cranker-supplied; pinned by the `user_inbox_authority` PDA derivation
    /// below + the NTT release ATA-authority check chain. See handler doc.
    /// CHECK: see safety chain in handler doc.
    pub user_wallet: UncheckedAccount<'info>,

    /// Per-user inbox PDA. Owns `user_inbox_ata`; signs the sweep.
    /// CHECK: PDA-derived; doubles as token authority.
    #[account(
        seeds = [USER_INBOX_SEED, user_wallet.key().as_ref()],
        bump,
    )]
    pub user_inbox_authority: UncheckedAccount<'info>,

    /// Per-user inbox USDC ATA. NTT release_inbound deposits here; the
    /// sweep transfers exactly `flow.amount` out into `usdc_ata`.
    /// `init_if_needed` is NOT used here — the FOGO `bridge_ntt_tokens`
    /// arg `pay_destination_ata_rent: true` causes the Wormhole
    /// executor to create the ATA on first delivery.
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user_inbox_authority,
        associated_token::token_program = token_program,
    )]
    pub user_inbox_ata: InterfaceAccount<'info, TokenAccount>,

    /// Per-VAA NTT inbox-item PDA — its pubkey seeds the flow PDA.
    /// We deliberately do NOT put `#[account(owner = NTT_USDC_PROGRAM_ID)]`
    /// here: on a fresh claim the account doesn't exist yet (the NTT
    /// redeem CPI inside the handler creates it), so Anchor's
    /// pre-handler owner constraint would fail every first-time claim.
    /// The owner check is enforced inside the handler's
    /// `inbox_already_released` skip branch — the *only* path where
    /// no NTT CPI runs and forgery is therefore possible.
    /// CHECK: conditional owner check + discriminator/recipient checks in handler.
    pub ntt_inbox_item: UncheckedAccount<'info>,

    /// `owner = NTT_USDC_PROGRAM_ID` pins the writer; nothing outside NTT can
    /// have crafted this data.
    /// CHECK: owner + discriminator + offset checks in the handler.
    #[account(owner = NTT_USDC_PROGRAM_ID)]
    pub ntt_transceiver_message: UncheckedAccount<'info>,

    /// `init` blocks double-claims against the same NTT inbox item.
    #[account(
        init,
        payer = payer,
        space = 8 + Flow::INIT_SPACE,
        seeds = [FLOW_INBOUND_SEED, ntt_inbox_item.key().as_ref()],
        bump,
    )]
    pub inflight_flow: Account<'info, Flow>,

    /// Withdraw-chain mutex gate. `SystemAccount` asserts
    /// `owner == system_program::ID`, true iff the singleton
    /// `RedemptionTracker` PDA does NOT currently exist — pausing deposit
    /// USDC inflows so they can't pollute `claim_redemption_usdc`'s
    /// snapshot/delta math.
    #[account(
        seeds = [REDEMPTION_TRACKER_SEED],
        bump,
    )]
    pub redemption_tracker: SystemAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
