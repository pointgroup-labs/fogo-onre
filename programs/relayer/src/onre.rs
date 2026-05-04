//! OnRe instruction arg layouts.
//!
//! These mirror the upstream Anchor handler signatures. When OnRe rev's an
//! instruction's args struct, this is the one file that must change in
//! lock-step. Discriminators and account-slot indices live next to them in
//! `constants.rs` for the same reason.

use anchor_lang::prelude::*;

#[derive(AnchorSerialize)]
pub struct OnreTakeOfferArgs {
    pub amount: u64,
    pub approval_message: Option<Vec<u8>>,
}

#[derive(AnchorSerialize)]
pub struct OnreCreateRedemptionRequestArgs {
    pub amount: u64,
}

#[derive(AnchorSerialize)]
pub struct OnreCancelRedemptionRequestArgs {}
