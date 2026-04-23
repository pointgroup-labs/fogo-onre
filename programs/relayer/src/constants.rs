use anchor_lang::prelude::*;

/// OnRe program (Solana mainnet).
pub const ONRE_PROGRAM_ID: Pubkey = pubkey!("onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe");

/// Wormhole Core Bridge — owner of posted-VAA accounts; validated in `claim_usdc`.
pub const WORMHOLE_CORE_BRIDGE_ID: Pubkey = pubkey!("worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth");

/// Wormhole Portal Token Bridge — handles USDC bridging via
/// `Complete/TransferWrappedWithPayload`.
pub const GATEWAY_PROGRAM_ID: Pubkey = pubkey!("wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb");

/// Wormhole NTT Manager (Locking mode). ONyc is canonical on Solana, so the
/// manager locks outbound and releases inbound (no mint/burn).
pub const NTT_PROGRAM_ID: Pubkey = pubkey!("nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk");

// Outbound recipient model: each inbound VAA carries the originating FOGO
// user wallet in its payload. `claim_usdc` / `unlock_onyc` parse it and
// persist to a `Flow` PDA seeded by the bridge's per-VAA claim account.
// `lock_onyc` / `send_usdc_to_user` then read `fogo_sender` as the outbound
// recipient. A stolen operator key cannot forge a claim PDA (CPI-created by
// the bridge program) and thus cannot redirect outbound transfers.

pub const FOGO_WORMHOLE_CHAIN_ID: u16 = 51;

// Portal Token Bridge — Solitaire single-byte enum tags.
// CompleteWrappedWithPayload(10) — claim inbound USDC from FOGO.
// TransferWrappedWithPayload(11) — send USDC back to a FOGO user.
pub const GATEWAY_COMPLETE_TRANSFER_IX: [u8; 1] = [10];
pub const GATEWAY_TRANSFER_OUT_IX: [u8; 1] = [11];

// Wormhole NTT — 8-byte Anchor sighashes: sha256("global:<name>")[..8].
// Locking mode: transfer_lock (outbound) + release_inbound_unlock (inbound).
// `redeem` is shared by both modes (records VAA into inbox; release happens
// in a second CPI).
pub const NTT_TRANSFER_LOCK_IX: [u8; 8] = [179, 158, 146, 148, 151, 46, 176, 200];
pub const NTT_REDEEM_IX: [u8; 8] = [184, 12, 86, 149, 70, 196, 97, 225];
pub const NTT_RELEASE_INBOUND_UNLOCK_IX: [u8; 8] = [182, 162, 62, 206, 197, 137, 83, 98];

// OnRe — `global:take_offer_permissionless`. Used by the deposit chain only
// (`swap_usdc_to_onyc` against the symmetric `Offer` PDA).
pub const ONRE_TAKE_OFFER_IX: [u8; 8] = [37, 190, 224, 77, 197, 39, 203, 230];

// OnRe — `global:create_redemption_request`. Used by the withdraw chain's
// `request_redemption_onyc` (added in WITHDRAW_REDESIGN.md §2.3.1). OnRe's
// withdraw side is asymmetric: there is no permissionless atomic counterpart
// to `take_offer_permissionless`. We submit a redemption request, then poll
// for its closure (signal that OnRe `redemption_admin` has fulfilled it).
pub const ONRE_CREATE_REDEMPTION_REQUEST_IX: [u8; 8] = [201, 53, 181, 254, 115, 137, 70, 151];

/// Position of the `redemption_request` account in OnRe's
/// `create_redemption_request` `Accounts` struct (zero-based). The relayer
/// forwards OnRe's account list verbatim through `ctx.remaining_accounts`,
/// so this is also the index of the `RedemptionRequest` PDA inside our
/// `remaining_accounts`. After the CPI returns Ok, OnRe's `init` constraint
/// has seed-validated this account, so we can trust its key as the real PDA
/// without an explicit Anchor slot in our own `Accounts` struct (which would
/// otherwise be a cranker-controlled second source of truth — the bug fixed
/// in commit "fix(relayer): bind tracker.redemption_request to CPI account").
pub const ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX: usize = 2;

// OnRe — `global:cancel_redemption_request`. Authority-only escape hatch
// invoked from `cancel_redemption_onyc` when an OnRe redemption is stuck
// (e.g. `redemption_admin` outage, kill switch, KYC issue). Returns the
// locked ONyc to the redeemer's ATA — for us, that's `relayer_authority`'s
// `onyc_ata`, since we passed `relayer_authority` as the redeemer in the
// matching `create_redemption_request`. Sighash:
// `sha256("global:cancel_redemption_request")[..8]`.
pub const ONRE_CANCEL_REDEMPTION_REQUEST_IX: [u8; 8] = [77, 155, 4, 179, 114, 233, 162, 45];

/// Position of the `redemption_request` account in OnRe's
/// `cancel_redemption_request` `Accounts` struct (zero-based). Currently
/// the same slot as in `create_redemption_request` (2), but pinned
/// independently because OnRe could theoretically reorder either struct
/// without touching the other. `cancel_redemption_onyc` reads the key at
/// this index post-CPI to confirm OnRe consumed the very PDA we recorded
/// on `tracker.redemption_request`.
///
/// Source of truth (verified at session start, 2026-04):
/// `onre-finance/onre-sol::programs/onreapp/src/instructions/redemption/
/// cancel_redemption_request.rs` — `state(0), redemption_offer(1),
/// redemption_request(2), signer(3), redeemer(4), ...`
pub const ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX: usize = 2;

/// `RedemptionOffer` PDA seed under OnRe. Note: seed order is
/// `[seed, ONyc_mint, USDC_mint]` — the *opposite* of the deposit `Offer`
/// PDA (`[b"offer", USDC_mint, ONyc_mint]`). Don't reuse `OFFER_SEED` here.
pub const ONRE_REDEMPTION_OFFER_SEED: &[u8] = b"redemption_offer";

/// `RedemptionRequest` PDA seed under OnRe. Per-request, derived as
/// `[seed, redemption_offer, request_counter_le_u64]`. Counter is read off
/// the `RedemptionOffer` account *before* CPI fires (see spec §2.3.1 step 3).
pub const ONRE_REDEMPTION_REQUEST_SEED: &[u8] = b"redemption_request";

/// Single global PDA owning every redemption-vault token account on OnRe.
pub const ONRE_REDEMPTION_OFFER_VAULT_AUTHORITY_SEED: &[u8] = b"redemption_offer_vault_authority";

/// Singleton sidecar PDA seed: `[seed]`. Exactly one `RedemptionTracker`
/// can exist at a time across the whole program, doubling as the in-flight
/// mutex (init fails while it exists). Bound to the active outbound `Flow`
/// via `tracker.flow`. See `state::RedemptionTracker` and
/// `docs/WITHDRAW_REDESIGN.md` §2.2.
pub const REDEMPTION_TRACKER_SEED: &[u8] = b"redemption_tracker";

/// SPL Token `Approve` (variant 4) — needed for the NTT session-authority
/// delegate handshake in `lock_onyc`.
pub const SPL_TOKEN_APPROVE_IX_TAG: u8 = 4;

/// Owner of all long-lived token accounts; signs outbound CPIs.
pub const RELAYER_SEED: &[u8] = b"relayer";

/// Owner of the deposit-leg USDC + ONyc intermediate ATAs. Introduced to
/// isolate deposit-chain USDC inflows from the `relayer_authority` USDC ATA,
/// which OnRe pays into during withdraw-leg `fulfill_redemption_request`
/// (its `user_token_out_account` is `associated(USDC, redeemer = relayer_authority)`,
/// pinned by KYC whitelist on OnRe's side and so not movable). Without
/// isolation the deposit-chain `claim_usdc` inflows would pollute the
/// `claim_redemption_usdc` snapshot/delta math and let withdraw-side flows
/// over-attribute deposit USDC to themselves. See WITHDRAW_REDESIGN.md §2.5.
pub const DEPOSIT_AUTHORITY_SEED: &[u8] = b"deposit_authority";

/// TB redeemer PDA, used only by `claim_usdc`. TB enforces that the inbound
/// token account's owner equals either `vaa.to` or the redeemer PDA, so
/// `claim_usdc` uses a short-lived redeemer-owned USDC ATA as the TB `to`
/// account, then sweeps into the authority-owned ATA in the same tx.
pub const REDEEMER_SEED: &[u8] = b"redeemer";

/// TB `sender` PDA (under this program ID), used only by `send_usdc_to_user`.
/// When the outbound CPI sets `cpi_program_id = Some(crate::ID)`, TB requires
/// the caller to sign as `["sender"]` under that program.
pub const SENDER_SEED: &[u8] = b"sender";

pub const CONFIG_SEED: &[u8] = b"relayer_config";

/// Inbound flow PDA prefix (deposit leg). Seeds: `[FLOW_INBOUND_SEED, claim_pda]`.
pub const FLOW_INBOUND_SEED: &[u8] = b"inflight";

/// Outbound flow PDA prefix (withdrawal leg). Seeds: `[FLOW_OUTBOUND_SEED, inbox_pda]`.
pub const FLOW_OUTBOUND_SEED: &[u8] = b"outflight";

/// NTT session-authority PDA prefix. NTT derives a per-call PDA as
/// `[NTT_SESSION_AUTHORITY_SEED, sender, keccak(transfer_args)]` under
/// `NTT_PROGRAM_ID`; we approve it as SPL `Approve` delegate before
/// `transfer_lock`.
pub const NTT_SESSION_AUTHORITY_SEED: &[u8] = b"session_authority";
