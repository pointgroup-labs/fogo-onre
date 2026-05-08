use anchor_lang::prelude::*;

#[event]
pub struct UsdcClaimed {
    pub flow: Pubkey,
    pub ntt_inbox_item: Pubkey,
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

#[event]
pub struct OnycSwapped {
    pub flow: Pubkey,
    pub gross_amount: u64,
    pub fee_amount: u64,
    pub net_amount: u64,
}

#[event]
pub struct OnycLocked {
    pub flow: Pubkey,
    pub ntt_inbox_item: Pubkey,
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

#[event]
pub struct RedemptionRequested {
    pub flow: Pubkey,
    pub redemption_request: Pubkey,
    pub gross_amount: u64,
    pub fee_amount: u64,
    pub net_amount: u64,
    pub usdc_ata_pre_balance: u64,
}

#[event]
pub struct RedemptionCancelled {
    pub flow: Pubkey,
    pub redemption_request: Pubkey,
    pub returned_onyc_amount: u64,
}

#[event]
pub struct RedemptionClaimed {
    pub flow: Pubkey,
    pub redemption_request: Pubkey,
    pub onyc_amount_in: u64,
    pub usdc_received: u64,
}
