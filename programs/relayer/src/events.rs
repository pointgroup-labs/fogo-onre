use anchor_lang::prelude::*;

use crate::state::Direction;

#[event]
pub struct Received {
    pub flow: Pubkey,
    pub ntt_inbox_item: Pubkey,
    pub recipient: Pubkey,
    pub direction: Direction,
    pub amount: u64,
}

#[event]
pub struct Swapped {
    pub flow: Pubkey,
    pub direction: Direction,
    pub gross_in: u64,
    pub fee: u64,
    pub net_out: u64,
    pub floor: u64,
    pub swap_program: Pubkey,
}

#[event]
pub struct Sent {
    pub flow: Pubkey,
    pub ntt_inbox_item: Pubkey,
    pub recipient: Pubkey,
    pub direction: Direction,
    pub amount: u64,
}

#[event]
pub struct Refunded {
    pub flow: Pubkey,
    pub ntt_inbox_item: Pubkey,
    pub recipient: Pubkey,
    pub direction: Direction,
    pub amount: u64,
}
