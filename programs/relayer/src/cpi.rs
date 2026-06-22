use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use anchor_spl::token_interface::{TransferChecked, transfer_checked};

use crate::{constants::RELAYER_SEED, error::RelayerError};

/// SPL `Approve` instruction tag.
pub const SPL_TOKEN_APPROVE_IX_TAG: u8 = 4;

/// SPL `Revoke` instruction tag.
pub const SPL_TOKEN_REVOKE_IX_TAG: u8 = 5;

/// Invoke an external program signed by the relayer authority PDA.
/// `Some(info)`: PDA must appear in `remaining_accounts`; its slot is forced
/// `is_signer`, errors if absent. `None`: passthrough for CPIs with no relayer
/// signer slot (e.g. NTT `release_wormhole_outbound`).
pub fn invoke_relayer_signed<'info, A: AnchorSerialize>(
    program_id: Pubkey,
    discriminator: &[u8],
    args: &A,
    remaining_accounts: &[AccountInfo<'info>],
    authority: Option<&AccountInfo<'info>>,
    authority_bump: u8,
) -> Result<()> {
    let mut metas: Vec<AccountMeta> = Vec::with_capacity(remaining_accounts.len());
    let mut authority_seen = false;

    for a in remaining_accounts {
        let is_authority = authority.is_some_and(|auth| a.key == auth.key);
        authority_seen |= is_authority;
        metas.push(AccountMeta { pubkey: *a.key, is_signer: a.is_signer || is_authority, is_writable: a.is_writable });
    }

    if authority.is_some() {
        require!(authority_seen, RelayerError::AuthorityNotInAccounts);
    }

    let mut data = Vec::with_capacity(discriminator.len() + 64);
    data.extend_from_slice(discriminator);
    args.serialize(&mut data)?;

    let auth_bump_arr = [authority_bump];
    let auth_seeds: &[&[u8]] = &[RELAYER_SEED, &auth_bump_arr];

    let ix = Instruction { program_id, accounts: metas, data };
    invoke_signed(&ix, remaining_accounts, &[auth_seeds])?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn relayer_signed_transfer_checked<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    authority_bump: u8,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump_arr = [authority_bump];
    let seeds: &[&[u8]] = &[RELAYER_SEED, &bump_arr];
    transfer_checked(
        CpiContext::new_with_signer(
            *token_program.key,
            TransferChecked { from: from.clone(), mint: mint.clone(), to: to.clone(), authority: authority.clone() },
            &[seeds],
        ),
        amount,
        decimals,
    )
}

/// Approve the NTT session-authority PDA as SPL delegate over `source_ata`.
/// `transfer_lock` consumes this delegation. Session authority is located
/// in `remaining_accounts` so callers can keep the slot positional.
#[allow(clippy::too_many_arguments)]
pub fn approve_ntt_session_authority<'info>(
    token_program: &AccountInfo<'info>,
    source_ata: &AccountInfo<'info>,
    relayer_authority: &AccountInfo<'info>,
    authority_bump: u8,
    session_authority: Pubkey,
    remaining_accounts: &[AccountInfo<'info>],
    amount: u64,
) -> Result<()> {
    let session_auth_info = remaining_accounts
        .iter()
        .find(|a| a.key() == session_authority)
        .ok_or(RelayerError::MissingSessionAuthority)?;

    let bump_arr = [authority_bump];
    let signer_seeds: &[&[u8]] = &[RELAYER_SEED, &bump_arr];

    let approve_ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source_ata.key, false),
            AccountMeta::new_readonly(session_authority, false),
            AccountMeta::new_readonly(*relayer_authority.key, true),
        ],
        data: {
            let mut d = Vec::with_capacity(9);
            d.push(SPL_TOKEN_APPROVE_IX_TAG);
            d.extend_from_slice(&amount.to_le_bytes());
            d
        },
    };

    invoke_signed(
        &approve_ix,
        &[source_ata.clone(), session_auth_info.to_account_info(), relayer_authority.clone(), token_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

/// PDA-signed SPL `Approve` bounding `delegate`'s reach to exactly `amount`
/// from `source_ata`. SPL auto-clears the delegation at zero, so no explicit
/// `Revoke` is needed when the swap consumes exactly `amount`.
#[allow(clippy::too_many_arguments)]
pub fn approve_swap_delegate<'info>(
    token_program: &AccountInfo<'info>,
    source_ata: &AccountInfo<'info>,
    relayer_authority: &AccountInfo<'info>,
    authority_bump: u8,
    delegate: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    let bump_arr = [authority_bump];
    let signer_seeds: &[&[u8]] = &[RELAYER_SEED, &bump_arr];

    let approve_ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source_ata.key, false),
            AccountMeta::new_readonly(*delegate.key, false),
            AccountMeta::new_readonly(*relayer_authority.key, true),
        ],
        data: {
            let mut d = Vec::with_capacity(9);
            d.push(SPL_TOKEN_APPROVE_IX_TAG);
            d.extend_from_slice(&amount.to_le_bytes());
            d
        },
    };

    invoke_signed(
        &approve_ix,
        &[source_ata.clone(), delegate.clone(), relayer_authority.clone(), token_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}

/// Clear any delegate on a relayer-owned ATA (PDA-signed, idempotent). Run
/// before the swap CPI so a stale approval can't DoS the post-CPI
/// pristine-ATA assert.
pub fn revoke_relayer_delegate<'info>(
    token_program: &AccountInfo<'info>,
    source_ata: &AccountInfo<'info>,
    relayer_authority: &AccountInfo<'info>,
    authority_bump: u8,
) -> Result<()> {
    let bump_arr = [authority_bump];
    let signer_seeds: &[&[u8]] = &[RELAYER_SEED, &bump_arr];

    let revoke_ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source_ata.key, false),
            AccountMeta::new_readonly(*relayer_authority.key, true),
        ],
        data: vec![SPL_TOKEN_REVOKE_IX_TAG],
    };

    invoke_signed(
        &revoke_ix,
        &[source_ata.clone(), relayer_authority.clone(), token_program.clone()],
        &[signer_seeds],
    )?;
    Ok(())
}
