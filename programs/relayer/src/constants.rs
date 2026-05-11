use anchor_lang::prelude::*;

pub const FOGO_WORMHOLE_CHAIN_ID: u16 = 51;

#[constant]
pub const ONRE_PROGRAM_ID: Pubkey = pubkey!("onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe");

#[constant]
pub const NTT_USDC_PROGRAM_ID: Pubkey = pubkey!("nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk");

#[constant]
pub const NTT_ONYC_PROGRAM_ID: Pubkey = pubkey!("nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd");

pub const NTT_TRANSFER_LOCK_IX: [u8; 8] = [179, 158, 146, 148, 151, 46, 176, 200];
pub const NTT_REDEEM_IX: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];
pub const NTT_RELEASE_INBOUND_UNLOCK_IX: [u8; 8] = [182, 162, 62, 206, 197, 137, 83, 98];

/// Wormhole Core Bridge program id. Documentation pin only — release CPIs
/// dispatch via `remaining_accounts`, no on-chain read site today.
#[constant]
pub const WORMHOLE_CORE_PROGRAM_ID: Pubkey =
    pubkey!("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");

/// `release_wormhole_outbound` discriminator in the OnRe ONyc NTT manager
/// (v3.0.0 IDL — transceiver compiled into manager binary).
/// = `sha256("global:release_wormhole_outbound")[..8]`.
pub const NTT_RELEASE_WORMHOLE_OUTBOUND_IX: [u8; 8] =
    [0xCA, 0x57, 0x33, 0xAD, 0x8E, 0xA0, 0xBC, 0xCC];

pub const ONRE_TAKE_OFFER_IX: [u8; 8] = [37, 190, 224, 77, 197, 39, 203, 230];

/// OnRe deposit `Offer` PDA seed: `[seed, token_in_mint, token_out_mint]`.
/// For the relayer's deposit-side oracle (USDC → ONyc) the derivation is
/// `[b"offer", usdc_mint, onyc_mint]` under `ONRE_PROGRAM_ID`. This is the
/// pricing-vector source `swap_onyc_to_usdc` consults to derive the
/// NAV-anchored slippage floor — pinning it on-chain is the single
/// load-bearing check that prevents an attacker from forging an offer
/// account with mint bytes at the expected offsets and a near-zero price
/// vector.
pub const ONRE_DEPOSIT_OFFER_SEED: &[u8] = b"offer";

/// SPL `Approve` instruction tag. NTT session-authority delegate handshake.
pub const SPL_TOKEN_APPROVE_IX_TAG: u8 = 4;

pub const RELAYER_SEED: &[u8] = b"relayer";
pub const CONFIG_SEED: &[u8] = b"relayer_config";

/// Minimum slot delay for fee *increases*. ≈ 2 days at 400ms slots.
pub const FEE_TIMELOCK_SLOTS: u64 = 432_000;

/// Hard ceiling on fees. Without an upstream FOGO vault to bound externally,
/// this contract is the user-facing trust boundary; 10% caps round-trip
/// damage from a compromised authority key at ~19% (`1 − 0.9²`).
pub const MAX_FEE_BPS: u16 = 1000;

pub const FLOW_INBOUND_SEED: &[u8] = b"inflight";
pub const FLOW_OUTBOUND_SEED: &[u8] = b"outflight";

/// Approved as SPL `Approve` delegate before NTT `transfer_lock`.
pub const NTT_SESSION_AUTHORITY_SEED: &[u8] = b"session_authority";

/// Per-user inbox authority PDA seed: `[USER_INBOX_SEED, user_wallet]`.
/// The webapp signs an intent whose recipient is this PDA's USDC ATA;
/// `claim_usdc` PDA-signs a sweep from that ATA into the relayer USDC ATA,
/// recording `user_wallet` as `flow.fogo_sender` for the return leg.
pub const USER_INBOX_SEED: &[u8] = b"user_inbox";

// SECURITY-CRITICAL CROSS-PROGRAM PIN (deposit flow trust chain):
//   1. webapp signs an intent → recipient = per-user inbox PDA on Solana
//   2. FOGO `intent_transfer.bridge_ntt_tokens` bridges via NTT;
//      the from-ATA owner is the singleton `[INTENT_TRANSFER_SETTER_SEED]`
//      PDA under `INTENT_TRANSFER_PROGRAM_ID`
//   3. that PDA surfaces as `NttManagerMessage.sender` on the VAA
//   4. `claim_usdc` requires `sender == intent_transfer setter PDA`,
//      rejecting any direct (non-intent) NTT bridge to the same recipient
//
// If `intent_transfer` rotates its setter seed OR redeploys at a new program
// ID, this relayer must redeploy in lockstep. DO NOT make these
// runtime-rotatable via `RelayerConfig` — a stolen authority key could
// otherwise redirect the entire deposit flow.

#[constant]
pub const INTENT_TRANSFER_PROGRAM_ID: Pubkey =
    pubkey!("Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD");

pub const INTENT_TRANSFER_SETTER_SEED: &[u8] = b"intent_transfer";

/// Hard cap on slippage tolerance accepted by `swap_onyc_to_usdc`. Used as
/// the haircut against OnRe's NAV-derived gross expected output:
/// `floor = gross_expected * (10_000 - MAX_SLIPPAGE_BPS) / 10_000`.
///
/// Tightened to 10 bps under the swap-only withdraw design — this constant
/// *is* the security boundary now (no cancel-path fallback to fall back on),
/// and 10 bps is the operational floor we expect ONyc/USDC to clear at
/// typical redemption sizes via Jupiter.
pub const MAX_SLIPPAGE_BPS: u16 = 10;

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
/// inside `swap_onyc_to_usdc`'s NAV-floor calculation.
pub const ONRE_PRICE_DECIMALS: u32 = 9;
pub const ONRE_PRICE_DENOMINATOR: u128 = 1_000_000_000;
pub const ONRE_APR_SCALE: u128 = 1_000_000;
pub const ONRE_SECONDS_IN_YEAR: u128 = 31_536_000;
