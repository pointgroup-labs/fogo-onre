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

// OnRe — `global:take_offer_permissionless`.
pub const ONRE_TAKE_OFFER_IX: [u8; 8] = [37, 190, 224, 77, 197, 39, 203, 230];

/// SPL Token `Approve` (variant 4) — needed for the NTT session-authority
/// delegate handshake in `lock_onyc`.
pub const SPL_TOKEN_APPROVE_IX_TAG: u8 = 4;

/// Owner of all long-lived token accounts; signs outbound CPIs.
pub const RELAYER_SEED: &[u8] = b"relayer";

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
