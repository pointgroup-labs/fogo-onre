//! OnRe instruction arg layouts.
//!
//! These mirror the upstream Anchor handler signatures. When OnRe rev's an
//! instruction's args struct, this is the one file that must change in
//! lock-step. Discriminators and account-slot indices live next to them in
//! `constants.rs` for the same reason.

use anchor_lang::prelude::*;

/// Args for OnRe `take_offer_permissionless` (deposit-leg swap). The relayer
/// always targets permissionless offers, so `approval_message` is `None`.
#[derive(AnchorSerialize)]
pub struct OnreTakeOfferArgs {
    pub amount: u64,
    pub approval_message: Option<Vec<u8>>,
}

/// Args for OnRe `create_redemption_request` (withdraw-leg request).
#[derive(AnchorSerialize)]
pub struct OnreCreateRedemptionRequestArgs {
    pub amount: u64,
}

/// Args for OnRe `cancel_redemption_request` (withdraw-leg recovery hatch).
/// Takes no payload — the targeted request is selected by account.
#[derive(AnchorSerialize)]
pub struct OnreCancelRedemptionRequestArgs {}
