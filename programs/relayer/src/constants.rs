use anchor_lang::prelude::*;

pub const FOGO_WORMHOLE_CHAIN_ID: u16 = 51;

pub const ONRE_PROGRAM_ID: Pubkey = pubkey!("onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe");
pub const NTT_PROGRAM_ID: Pubkey = pubkey!("nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk");

pub const NTT_TRANSFER_LOCK_IX: [u8; 8] = [179, 158, 146, 148, 151, 46, 176, 200];
pub const NTT_REDEEM_IX: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];
pub const NTT_RELEASE_INBOUND_UNLOCK_IX: [u8; 8] = [182, 162, 62, 206, 197, 137, 83, 98];

pub const ONRE_TAKE_OFFER_IX: [u8; 8] = [37, 190, 224, 77, 197, 39, 203, 230];

/// OnRe `create_redemption_request` sighash. Used by the asymmetric
/// withdraw chain — there's no permissionless atomic counterpart to
/// `take_offer_permissionless`, so we submit a request and poll for closure.
pub const ONRE_CREATE_REDEMPTION_REQUEST_IX: [u8; 8] = [201, 53, 181, 254, 115, 137, 70, 151];

/// Slot index for OnRe's `create_redemption_request.redemption_request`.
/// `request_redemption_onyc` reads this index from `ctx.remaining_accounts`
/// post-CPI; OnRe's `init` constraint has seed-validated it, so binding to
/// `tracker.redemption_request` is trustworthy without a second source of truth.
pub const ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX: usize = 2;

/// OnRe `cancel_redemption_request` sighash. Authority-only escape hatch
/// invoked from `cancel_redemption_onyc` when an OnRe redemption is stuck.
pub const ONRE_CANCEL_REDEMPTION_REQUEST_IX: [u8; 8] = [77, 155, 4, 179, 114, 233, 162, 45];

/// Slot index for OnRe's `cancel_redemption_request.redemption_request`.
/// Pinned independently from the create-side index — OnRe could reorder
/// either struct without touching the other.
pub const ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX: usize = 2;

/// `RedemptionOffer` PDA seed under OnRe. Note: seed order is
/// `[seed, ONyc_mint, USDC_mint]` — the *opposite* of the deposit `Offer`
/// PDA (`[b"offer", USDC_mint, ONyc_mint]`). Don't reuse `OFFER_SEED` here.
pub const ONRE_REDEMPTION_OFFER_SEED: &[u8] = b"redemption_offer";

/// `RedemptionRequest` PDA seed: `[seed, redemption_offer, request_counter_le_u64]`.
pub const ONRE_REDEMPTION_REQUEST_SEED: &[u8] = b"redemption_request";

pub const ONRE_REDEMPTION_OFFER_VAULT_AUTHORITY_SEED: &[u8] = b"redemption_offer_vault_authority";

/// Singleton sidecar PDA seed: `[seed]`. Exactly one `RedemptionTracker`
/// can exist at a time, doubling as the in-flight mutex.
pub const REDEMPTION_TRACKER_SEED: &[u8] = b"redemption_tracker";

/// Needed for the NTT session-authority delegate handshake in `lock_onyc`
/// and `send_usdc_to_user`.
pub const SPL_TOKEN_APPROVE_IX_TAG: u8 = 4;

pub const RELAYER_SEED: &[u8] = b"relayer";
pub const CONFIG_SEED: &[u8] = b"relayer_config";

/// Minimum slot delay for fee *increases*. ≈ 2 days at 400ms slots.
pub const FEE_TIMELOCK_SLOTS: u64 = 432_000;

/// Hard ceiling on `deposit_fee_bps` / `withdraw_fee_bps`, enforced by
/// `RelayerConfig::validate()`. Capped at 10% to bound the worst-case
/// damage from a compromised authority key — without an upstream FOGO
/// vault to bound fees externally, this contract is the user-facing
/// trust boundary. Round-trip worst case: ~19% (`1 − 0.9²`).
pub const MAX_FEE_BPS: u16 = 1000;

pub const FLOW_INBOUND_SEED: &[u8] = b"inflight";
pub const FLOW_OUTBOUND_SEED: &[u8] = b"outflight";

/// Approved as SPL `Approve` delegate before NTT `transfer_lock`.
pub const NTT_SESSION_AUTHORITY_SEED: &[u8] = b"session_authority";
