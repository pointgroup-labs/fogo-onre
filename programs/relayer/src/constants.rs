pub const FOGO_WORMHOLE_CHAIN_ID: u16 = 51;

pub const NTT_REDEEM_IX: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];
pub const NTT_RELEASE_INBOUND_UNLOCK_IX: [u8; 8] = [182, 162, 62, 206, 197, 137, 83, 98];
pub const NTT_TRANSFER_LOCK_IX: [u8; 8] = [179, 158, 146, 148, 151, 46, 176, 200];
pub const NTT_RELEASE_WORMHOLE_OUTBOUND_IX: [u8; 8] = [0xCA, 0x57, 0x33, 0xAD, 0x8E, 0xA0, 0xBC, 0xCC];

/// Approved as SPL `Approve` delegate before NTT `transfer_lock`.
pub const NTT_SESSION_AUTHORITY_SEED: &[u8] = b"session_authority";

pub const RELAYER_SEED: &[u8] = b"relayer";
pub const USER_INBOX_SEED: &[u8] = b"user_inbox";

/// Seed of `intent_transfer`'s singleton setter PDA. `receive` derives each
/// `PairConfig.intent_programs` entry's setter with this and matches the inbound
/// VAA `NttManagerMessage.sender` against them.
pub const INTENT_TRANSFER_SEED: &[u8] = b"intent_transfer";

/// Slots a `Received` flow must age before `refund` returns the original
/// token. ≈ 6 hours at 400ms slots — long enough for honest VAA/crank
/// latency, short enough to bound stuck funds.
pub const REFUND_TIMEOUT_SLOTS: u64 = 54_000;

/// Minimum slot delay for fee *increases*. ≈ 2 days at 400ms slots.
pub const FEE_TIMELOCK_SLOTS: u64 = 432_000;

/// Hard ceiling on fees. Without an upstream FOGO vault to bound externally,
/// this contract is the user-facing trust boundary; 10% caps round-trip
/// damage from a compromised authority key at ~19% (`1 − 0.9²`).
pub const MAX_FEE_BPS: u16 = 1000;
