//! Raw CPI helper.
//!
//! Every external CPI goes through one helper that pins two compile-time
//! invariants:
//!
//! 1. Destination program ID (see `constants.rs`).
//! 2. Instruction discriminator.
//!
//! A compromised operator key therefore cannot redirect a CPI to an
//! attacker-controlled program or call a different method on the real one.
//! Operator-controllable surface is reduced to the *arguments* serialized
//! into the pinned method and the *accounts* forwarded as `remaining_accounts`.
//!
//! ## Account forwarding contract
//!
//! Upstream Anchor programs declare fixed `#[derive(Accounts)]` layouts
//! indexed by position, so we cannot reorder, append, or synthesize
//! writable/signer flags. The caller must:
//!
//! - Pass the complete, correctly-ordered upstream account list, including
//!   the relayer authority PDA at the slot the upstream program expects.
//! - Set writability flags correctly when building the outer transaction
//!   (this helper copies them verbatim).
//!
//! This helper locates the authority PDA by pubkey and forces its
//! `is_signer = true`. If absent, we error.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::constants::{REDEEMER_SEED, RELAYER_SEED, SENDER_SEED};
use crate::error::RelayerError;

/// Invoke an external program signed by the relayer authority PDA.
///
/// `discriminator` is copied verbatim to the front of the instruction data:
/// 8-byte Anchor sighash for Anchor programs, 1-byte variant tag for
/// native-Solana-style programs (Wormhole Gateway).
///
/// Use this for OnRe, NTT, and outbound Gateway CPIs. For Gateway
/// `CompleteWrappedWithPayload` use `..._with_redeemer` instead.
pub fn invoke_relayer_signed<'info, A: AnchorSerialize>(
    program_id: Pubkey,
    discriminator: &[u8],
    args: &A,
    remaining_accounts: &[AccountInfo<'info>],
    authority: &AccountInfo<'info>,
    authority_bump: u8,
) -> Result<()> {
    let (metas, data) =
        build_ix_metas_and_data(discriminator, args, remaining_accounts, authority.key, None)?;

    let auth_bump_arr = [authority_bump];
    let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump_arr];

    let ix = Instruction {
        program_id,
        accounts: metas,
        data,
    };
    invoke_signed(&ix, remaining_accounts, &[auth_seeds])?;
    Ok(())
}

/// Like `invoke_relayer_signed`, but additionally signs as the redeemer PDA.
///
/// Token Bridge's `CompleteWrappedWithPayload` requires the redeemer to
/// co-sign as proof the payload reached its intended receiver. Used
/// exclusively by `claim_usdc`.
#[allow(clippy::too_many_arguments)]
pub fn invoke_relayer_signed_with_redeemer<'info, A: AnchorSerialize>(
    program_id: Pubkey,
    discriminator: &[u8],
    args: &A,
    remaining_accounts: &[AccountInfo<'info>],
    authority: &AccountInfo<'info>,
    authority_bump: u8,
    redeemer: Pubkey,
    redeemer_bump: u8,
) -> Result<()> {
    let (metas, data) = build_ix_metas_and_data(
        discriminator,
        args,
        remaining_accounts,
        authority.key,
        Some(redeemer),
    )?;

    let auth_bump_arr = [authority_bump];
    let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump_arr];
    let red_bump_arr = [redeemer_bump];
    let red_seeds: &[&[u8]] = &[REDEEMER_SEED, &red_bump_arr];

    let ix = Instruction {
        program_id,
        accounts: metas,
        data,
    };
    invoke_signed(&ix, remaining_accounts, &[auth_seeds, red_seeds])?;
    Ok(())
}

/// Like `invoke_relayer_signed`, but additionally signs as the Token Bridge
/// `sender` PDA (seeds = `["sender"]` under this program ID).
///
/// `TransferWrappedWithPayload` with `cpi_program_id = Some(p)` requires the
/// caller to sign as PDA `["sender"]` under `p`; without it, TB rejects with
/// `InvalidSigner(<sender_pda>)`. Used exclusively by `send_usdc_to_user`.
#[allow(clippy::too_many_arguments)]
pub fn invoke_relayer_signed_with_sender<'info, A: AnchorSerialize>(
    program_id: Pubkey,
    discriminator: &[u8],
    args: &A,
    remaining_accounts: &[AccountInfo<'info>],
    authority: &AccountInfo<'info>,
    authority_bump: u8,
    sender: Pubkey,
    sender_bump: u8,
) -> Result<()> {
    let (metas, data) = build_ix_metas_and_data(
        discriminator,
        args,
        remaining_accounts,
        authority.key,
        Some(sender),
    )?;

    let auth_bump_arr = [authority_bump];
    let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump_arr];
    let send_bump_arr = [sender_bump];
    let send_seeds: &[&[u8]] = &[SENDER_SEED, &send_bump_arr];

    let ix = Instruction {
        program_id,
        accounts: metas,
        data,
    };
    invoke_signed(&ix, remaining_accounts, &[auth_seeds, send_seeds])?;
    Ok(())
}

/// Walk `remaining_accounts`, force the signer flag on the authority PDA
/// (and redeemer PDA if supplied), and assemble the raw instruction data.
/// Errors if a required PDA is missing.
fn build_ix_metas_and_data<'info, A: AnchorSerialize>(
    discriminator: &[u8],
    args: &A,
    remaining_accounts: &[AccountInfo<'info>],
    authority_key: &Pubkey,
    redeemer_key: Option<Pubkey>,
) -> Result<(Vec<AccountMeta>, Vec<u8>)> {
    let mut authority_seen = false;
    let mut redeemer_seen = false;
    let mut metas: Vec<AccountMeta> = Vec::with_capacity(remaining_accounts.len());

    for a in remaining_accounts {
        let is_authority = a.key == authority_key;
        let is_redeemer = redeemer_key.is_some_and(|k| *a.key == k);
        authority_seen |= is_authority;
        redeemer_seen |= is_redeemer;
        metas.push(AccountMeta {
            pubkey: *a.key,
            is_signer: a.is_signer || is_authority || is_redeemer,
            is_writable: a.is_writable,
        });
    }

    require!(authority_seen, RelayerError::AuthorityNotInAccounts);
    if redeemer_key.is_some() {
        require!(redeemer_seen, RelayerError::AuthorityNotInAccounts);
    }

    let mut data = Vec::with_capacity(discriminator.len() + 64);
    data.extend_from_slice(discriminator);
    args.serialize(&mut data)?;

    Ok((metas, data))
}
