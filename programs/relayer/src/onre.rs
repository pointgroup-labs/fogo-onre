//! Shared OnRe `take_offer_permissionless` CPI used by both swap legs.
//! Only the offer PDA in `remaining_accounts` differs between directions.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::TokenAccount;

use crate::constants::{ONRE_PROGRAM_ID, ONRE_TAKE_OFFER_IX};
use crate::cpi::invoke_relayer_signed;
use crate::error::RelayerError;
use crate::state::{Flow, FlowStatus, RelayerConfig};

/// OnRe `take_offer_permissionless` args. The relayer always targets
/// permissionless offers, so `approval_message` is `None`.
#[derive(AnchorSerialize)]
pub struct OnreTakeOfferArgs {
    pub amount: u64,
    pub approval_message: Option<Vec<u8>>,
}

/// Pre: `flow.status == Claimed`, `flow.amount > 0`.
/// Post: `flow.amount` = post-CPI delta into `destination_ata` (OnRe may
/// fill less than requested if the offer was partially consumed),
/// `flow.status = Swapped`.
///
/// `remaining_accounts` is OnRe's full account list for the target offer,
/// in OnRe's expected order, including the relayer authority PDA so the
/// CPI helper can force its signer flag.
pub fn execute_onre_swap<'info>(
    flow: &mut Account<'info, Flow>,
    destination_ata: &mut InterfaceAccount<'info, TokenAccount>,
    relayer_authority: &AccountInfo<'info>,
    relayer_config: &Account<'info, RelayerConfig>,
    remaining_accounts: &[AccountInfo<'info>],
) -> Result<()> {
    require!(
        flow.status == FlowStatus::Claimed,
        RelayerError::FlowStatusMismatch
    );
    require!(flow.amount > 0, RelayerError::ZeroAmountFlow);

    let pre_balance = destination_ata.amount;

    invoke_relayer_signed(
        ONRE_PROGRAM_ID,
        &ONRE_TAKE_OFFER_IX,
        &OnreTakeOfferArgs {
            amount: flow.amount,
            approval_message: None,
        },
        remaining_accounts,
        relayer_authority,
        relayer_config.relayer_authority_bump,
    )?;

    destination_ata.reload()?;
    let received = destination_ata
        .amount
        .checked_sub(pre_balance)
        .ok_or(RelayerError::BalanceUnderflow)?;
    require!(received > 0, RelayerError::ZeroAmountFlow);

    flow.amount = received;
    flow.status = FlowStatus::Swapped;
    Ok(())
}
