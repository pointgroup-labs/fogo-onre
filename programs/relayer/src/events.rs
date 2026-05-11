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
pub struct OnycSwappedToUsdc {
    pub flow: Pubkey,
    /// Pre-fee ONyc unlocked by `unlock_onyc` (== `flow.amount` at entry).
    pub gross_onyc: u64,
    /// Withdraw fee in ONyc, transferred to `fee_vault_onyc_ata`.
    pub fee_onyc: u64,
    /// Post-fee ONyc spent in the swap (== gross_onyc - fee_onyc).
    pub net_onyc: u64,
    /// Actual ONyc consumed by the swap; asserted == net_onyc on-chain.
    pub onyc_consumed: u64,
    /// USDC delta on the relayer-authority USDC ATA; asserted >= nav_floor.
    pub usdc_received: u64,
    /// NAV-anchored slippage floor the swap had to clear.
    pub nav_floor: u64,
    /// Router program ID — operator-chosen, surfaced for off-chain audit.
    pub swap_program: Pubkey,
}
