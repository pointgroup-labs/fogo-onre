//! Every event carries `flow: Pubkey` as the universal correlation handle
//! to its `Flow` PDA. Bridge-step events (`UsdcClaimed`, `OnycUnlocked`)
//! report only gross amounts — fees are taken at the swap step. Swap
//! events expose the gross/fee/net split.

use anchor_lang::prelude::*;

#[event]
pub struct UsdcClaimed {
    pub flow: Pubkey,
    pub gateway_claim: Pubkey,
    pub fogo_sender: [u8; 32],
    pub amount: u64,
}

#[event]
pub struct OnycUnlocked {
    pub flow: Pubkey,
    pub ntt_inbox_item: Pubkey,
    pub fogo_sender: [u8; 32],
    pub amount: u64,
}

/// `gross_amount` = ONyc received from OnRe; `fee_amount` = deposit fee
/// retained; `net_amount` = ONyc recorded on Flow (== amount the eventual
/// `lock_onyc` ships back to FOGO).
#[event]
pub struct OnycSwapped {
    pub flow: Pubkey,
    pub gross_amount: u64,
    pub fee_amount: u64,
    pub net_amount: u64,
}

/// `gross_amount` = ONyc input (== flow.amount from `unlock_onyc`);
/// `fee_amount` = withdrawal fee taken pre-swap; `net_amount` = ONyc
/// actually swapped; `usdc_received` = USDC recorded on Flow.
#[event]
pub struct UsdcSwapped {
    pub flow: Pubkey,
    pub gross_amount: u64,
    pub fee_amount: u64,
    pub net_amount: u64,
    pub usdc_received: u64,
}

#[event]
pub struct OnycLocked {
    pub flow: Pubkey,
    pub gateway_claim: Pubkey,
    pub fogo_sender: [u8; 32],
    pub amount: u64,
}

#[event]
pub struct UsdcSentToUser {
    pub flow: Pubkey,
    pub ntt_inbox_item: Pubkey,
    pub fogo_sender: [u8; 32],
    pub amount: u64,
}

/// Withdraw chain — emitted by `request_redemption_onyc` when ONyc has been
/// forwarded to OnRe and the singleton tracker is initialised.
/// `redemption_request` is the OnRe `RedemptionRequest` PDA we'll poll.
#[event]
pub struct RedemptionRequested {
    pub flow: Pubkey,
    pub redemption_request: Pubkey,
    pub gross_amount: u64,
    pub fee_amount: u64,
    pub net_amount: u64,
    pub usdc_ata_pre_balance: u64,
}

/// Withdraw chain — emitted by `cancel_redemption_onyc` when the authority
/// aborts an in-flight OnRe redemption (e.g. stuck `redemption_admin`,
/// kill-switch, KYC issue). `returned_onyc_amount` is the ONyc that OnRe
/// has unlocked back into the relayer's `onyc_ata` and is now re-recorded
/// on the flow as `flow.amount` with status rolled back to `Claimed`.
/// Note: the withdraw fee taken by `request_redemption_onyc` is NOT
/// refunded by this path — operator off-chain reconciliation handles dust.
#[event]
pub struct RedemptionCancelled {
    pub flow: Pubkey,
    pub redemption_request: Pubkey,
    pub returned_onyc_amount: u64,
}

/// Withdraw chain — emitted by `claim_redemption_usdc` after OnRe has
/// fulfilled and we've recorded the USDC delta on the flow. `usdc_received`
/// is the post-fulfillment ATA delta and the amount `send_usdc_to_user`
/// will ship back to FOGO.
#[event]
pub struct RedemptionClaimed {
    pub flow: Pubkey,
    pub redemption_request: Pubkey,
    pub onyc_amount_in: u64,
    pub usdc_received: u64,
}
