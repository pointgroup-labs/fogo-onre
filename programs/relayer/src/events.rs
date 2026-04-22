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
