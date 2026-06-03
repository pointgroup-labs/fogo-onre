use anchor_lang::prelude::*;

pub const FOGO_WORMHOLE_CHAIN_ID: u16 = 51;

pub const NTT_USDC_PROGRAM_ID: Pubkey = pubkey!("nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk");
pub const NTT_ONYC_PROGRAM_ID: Pubkey = pubkey!("nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd");

pub const NTT_BASE_PROGRAM: Pubkey = NTT_USDC_PROGRAM_ID;
pub const NTT_ASSET_PROGRAM: Pubkey = NTT_ONYC_PROGRAM_ID;

pub const NTT_REDEEM_IX: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];
pub const NTT_RELEASE_INBOUND_UNLOCK_IX: [u8; 8] = [182, 162, 62, 206, 197, 137, 83, 98];
pub const NTT_TRANSFER_LOCK_IX: [u8; 8] = [179, 158, 146, 148, 151, 46, 176, 200];
pub const NTT_RELEASE_WORMHOLE_OUTBOUND_IX: [u8; 8] = [0xCA, 0x57, 0x33, 0xAD, 0x8E, 0xA0, 0xBC, 0xCC];

/// Approved as SPL `Approve` delegate before NTT `transfer_lock`.
pub const NTT_SESSION_AUTHORITY_SEED: &[u8] = b"session_authority";

pub const ONRE_PROGRAM_ID: Pubkey = pubkey!("onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe");

/// OnRe deposit `Offer` PDA seed: `[seed, token_in_mint, token_out_mint]`.
pub const ONRE_DEPOSIT_OFFER_SEED: &[u8] = b"offer";

/// OnRe `Offer` account layout (mirrored from
/// `onre-finance/onre-sol/programs/onreapp/src/instructions/offer/offer_state.rs`).
/// Drift tripwire: pinned byte-for-byte against the mainnet fixture in
/// `onre::tests::offer_layout_matches_fixture`. Refresh both the fixture
/// and these constants in lockstep when OnRe re-lays out `Offer`.
pub const ONRE_OFFER_ACCOUNT_SIZE: usize = 608;
pub const ONRE_OFFER_VECTORS_OFFSET: usize = 72;
pub const ONRE_OFFER_VECTOR_SIZE: usize = 40;
pub const ONRE_OFFER_MAX_VECTORS: usize = 10;

/// OnRe price math constants (mirrored from
/// `instructions/offer/offer_utils.rs`). `ONRE_PRICE_DENOMINATOR =
/// 10^ONRE_PRICE_DECIMALS`; precomputed because the math hot path runs
/// inside the unified `swap` handler's NAV-floor calculation.
pub const ONRE_PRICE_DECIMALS: u32 = 9;
pub const ONRE_PRICE_DENOMINATOR: u128 = 1_000_000_000;
pub const ONRE_APR_SCALE: u128 = 1_000_000;
pub const ONRE_SECONDS_IN_YEAR: u128 = 31_536_000;

pub const RELAYER_SEED: &[u8] = b"relayer";
pub const CONFIG_SEED: &[u8] = b"relayer_config";

pub const FLOW_INBOUND_SEED: &[u8] = b"inflight";
pub const FLOW_OUTBOUND_SEED: &[u8] = b"outflight";

/// Per-user inbox authority PDA seed: `[USER_INBOX_SEED, user_wallet]`.
pub const USER_INBOX_SEED: &[u8] = b"user_inbox";

/// If `intent_transfer` rotates its setter seed OR redeploys at a new program
/// ID, this relayer must redeploy in lockstep. DO NOT make these
/// runtime-rotatable via `RelayerConfig` — a stolen authority key could
/// otherwise redirect the entire deposit flow.
pub const FOGO_INTENT_TRANSFER_PROGRAM_ID: Pubkey = pubkey!("Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD");
pub const INTENT_TRANSFER_PROGRAM_ID: Pubkey = pubkey!("inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9");
pub const INTENT_TRANSFER_SETTER_SEED: &[u8] = b"intent_transfer";

/// Permanent two-element setter allowlist accepted by `receive` (both
/// directions). Keeping Fogo's setter trusted is what preserves the
/// deposit switch-back fallback; adding OnRe's is what lets us own the
/// fee. Never remove either at runtime.
pub fn allowed_intent_setters() -> [Pubkey; 2] {
    [
        Pubkey::find_program_address(&[INTENT_TRANSFER_SETTER_SEED], &FOGO_INTENT_TRANSFER_PROGRAM_ID).0,
        Pubkey::find_program_address(&[INTENT_TRANSFER_SETTER_SEED], &INTENT_TRANSFER_PROGRAM_ID).0,
    ]
}

/// Minimum slot delay for fee *increases*. ≈ 2 days at 400ms slots.
pub const FEE_TIMELOCK_SLOTS: u64 = 432_000;

/// Hard ceiling on fees. Without an upstream FOGO vault to bound externally,
/// this contract is the user-facing trust boundary; 10% caps round-trip
/// damage from a compromised authority key at ~19% (`1 − 0.9²`).
pub const MAX_FEE_BPS: u16 = 1000;

/// Hard ceiling on the authority-configurable slippage tolerance
/// (`RelayerConfig.slippage_bps`). Bounds the worst-case haircut a
/// compromised authority key can apply to the NAV floor on both swap
/// legs: 200 bps (2%) per leg caps round-trip slippage damage while
/// leaving operational headroom above the 10 bps default for thin-book
/// redemptions. `configure` refuses any value above this.
pub const MAX_SLIPPAGE_BPS: u16 = 200;

/// Slippage tolerance seeded at `initialize`. 10 bps is the operational
/// floor we expect ONyc/USDC to clear at typical sizes via Jupiter; the
/// authority can tune within `[0, MAX_SLIPPAGE_BPS]` afterwards.
pub const DEFAULT_SLIPPAGE_BPS: u16 = 10;
