use anchor_lang::prelude::*;

use crate::constants::CONFIG_SEED;
use crate::error::RelayerError;

/// The only long-lived state in this program.
///
/// `authority` is a cold/admin key used only for governance. All operational
/// instructions are permissionless — recipients are VAA-bound, amounts are
/// flow-bound, and CPI targets are compile-time constants.
#[account]
#[derive(InitSpace)]
pub struct RelayerConfig {
    pub authority: Pubkey,

    /// Two-step rotation accommodates multisig→multisig handoffs where the two
    /// parties cannot atomically co-sign (e.g. two independent Squads vaults).
    /// `None` when no rotation is in flight; set by `configure(new_authority)`,
    /// promoted to `authority` by a separate `accept_authority` tx from this key.
    pub pending_authority: Option<Pubkey>,

    pub usdc_mint: Pubkey,
    pub onyc_mint: Pubkey,

    /// Single PDA-addressed token account holding ALL accumulated fees from
    /// both legs (denominated in ONyc).
    pub fee_vault: Pubkey,

    pub bump: u8,
    pub relayer_authority_bump: u8,

    /// Deposit-leg fee in bps (1 bps = 0.01%).
    pub deposit_fee_bps: u16,
    /// Withdrawal-leg fee in bps.
    pub withdraw_fee_bps: u16,
}

impl RelayerConfig {
    pub const SEEDS: &'static [u8] = CONFIG_SEED;

    pub fn validate(&self) -> Result<()> {
        require!(self.deposit_fee_bps <= 10_000, RelayerError::FeeBpsTooHigh);
        require!(self.withdraw_fee_bps <= 10_000, RelayerError::FeeBpsTooHigh);
        Ok(())
    }

    pub fn apply_deposit_fee(&self, gross: u64) -> Result<(u64, u64)> {
        apply_fee_bps(gross, self.deposit_fee_bps)
    }

    pub fn apply_withdraw_fee(&self, gross: u64) -> Result<(u64, u64)> {
        apply_fee_bps(gross, self.withdraw_fee_bps)
    }
}

/// Returns `(net, fee)` where `fee = floor(gross * bps / 10_000)`.
///
/// `try_from` is defense-in-depth — under the `validate()` invariant
/// `fee_u128 <= gross`, so the cast can't overflow today, but enforcing
/// locally turns a future invariant violation into `FeeOverflow` instead of
/// silent truncation.
fn apply_fee_bps(gross: u64, bps: u16) -> Result<(u64, u64)> {
    let fee_u128 = (gross as u128)
        .checked_mul(bps as u128)
        .ok_or(RelayerError::FeeOverflow)?
        / 10_000;
    let fee = u64::try_from(fee_u128).map_err(|_| RelayerError::FeeOverflow)?;
    let net = gross.checked_sub(fee).ok_or(RelayerError::FeeOverflow)?;
    require!(net > 0, RelayerError::ZeroAmountFlow);
    Ok((net, fee))
}

#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(test, derive(Debug))]
pub enum FlowStatus {
    /// Inbound bridge complete, awaiting swap. Borsh tag = 0 (DO NOT REORDER).
    Claimed,
    /// Swap complete, awaiting outbound bridge. Borsh tag = 1 (DO NOT REORDER).
    Swapped,
    /// Withdraw chain only: ONyc forwarded to OnRe via
    /// `create_redemption_request`; awaiting `redemption_admin` fulfillment
    /// (out-of-band) and a `claim_redemption_usdc` cranker call. Borsh tag = 2.
    ///
    /// **Appended (not inserted)** to preserve tags 0/1 for any already-
    /// allocated `Flow` PDAs from prior deploys. The
    /// `flow_status_borsh_tag_invariant` test guards this property.
    /// See `docs/WITHDRAW_REDESIGN.md` §2.1.
    RedemptionPending,
}

/// One-shot receipt binding an inbound bridge message to a FOGO user wallet.
/// Used by both legs — direction is implicit in the seed prefix
/// (`FLOW_INBOUND_SEED` vs `FLOW_OUTBOUND_SEED`).
///
/// PDA seeds: `[FLOW_*_SEED, bridge_claim_pda.key()]`. Uniqueness and replay
/// protection are delegated to the per-VAA claim account created by Wormhole
/// Gateway / NTT — no hashing needed here.
///
/// **Field set is byte-stable across the withdraw redesign**. Withdraw-chain
/// redemption tracking lives in the sidecar `RedemptionTracker` PDA below
/// rather than as new fields here, to preserve compatibility with any
/// already-allocated `Flow` PDAs.
#[account]
#[derive(InitSpace)]
pub struct Flow {
    /// Originator on FOGO; becomes the outbound recipient on the return leg.
    pub fogo_sender: [u8; 32],

    pub status: FlowStatus,

    /// Token amount for the current/next step.
    pub amount: u64,

    /// Receives rent on close.
    pub payer: Pubkey,

    pub bump: u8,
}

/// Singleton sidecar PDA tracking the in-flight withdraw-chain redemption.
///
/// PDA seeds: `[REDEMPTION_TRACKER_SEED]` (no per-flow discriminator —
/// only one withdraw redemption may be in flight across the whole program
/// at a time). The PDA's existence is the in-flight mutex: `init` in
/// `request_redemption_onyc` fails if another redemption is mid-flight,
/// preventing the USDC-delta race where two flows would otherwise read the
/// combined balance change as their own.
///
/// Created by `request_redemption_onyc`; closed by `claim_redemption_usdc`
/// (rent → `payer`). Never exists on the deposit chain.
///
/// See `docs/WITHDRAW_REDESIGN.md` §2.2.
#[account]
#[derive(InitSpace)]
pub struct RedemptionTracker {
    /// Outbound `Flow` PDA this tracker is bound to. Pinned by
    /// `claim_redemption_usdc` via `tracker.flow == flow.key()`.
    pub flow: Pubkey,

    /// OnRe `RedemptionRequest` PDA we created. The relayer polls for its
    /// closure as the fulfillment signal — when this account no longer
    /// exists on chain, OnRe's `redemption_admin` has fulfilled.
    pub redemption_request: Pubkey,

    /// Relayer's USDC ATA balance snapshotted *before*
    /// `create_redemption_request` fires. `claim_redemption_usdc` computes
    /// the post-fulfillment delta against this. Safe under the singleton
    /// constraint above — no sibling redemption can pollute the delta.
    pub usdc_ata_pre_balance: u64,

    /// ONyc amount net-of-fee that we sent to OnRe. Audit-trail field;
    /// not consumed by `claim_redemption_usdc` today, but emitted in events.
    pub onyc_amount_in: u64,

    /// Pays for init, receives rent on close. Set to whoever called
    /// `request_redemption_onyc`; may differ from the `claim_redemption_usdc`
    /// caller.
    pub payer: Pubkey,

    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err_code(e: Error) -> u32 {
        match e {
            Error::AnchorError(ae) => ae.error_code_number,
            _ => panic!("expected AnchorError, got {e:?}"),
        }
    }

    fn code_of(re: RelayerError) -> u32 {
        // Anchor error codes start at 6000 and increment by declaration order.
        // We compare via the `Discriminator`-style `u32` to keep tests stable
        // even if intermediate variants are added (which would shift numeric
        // codes — a separate concern flagged at audit time).
        (re as u32) + ERROR_CODE_OFFSET
    }

    #[test]
    fn zero_bps_passes_through_full_amount() {
        let (net, fee) = apply_fee_bps(1_000_000, 0).unwrap();
        assert_eq!(net, 1_000_000);
        assert_eq!(fee, 0);
    }

    #[test]
    fn one_bps_one_unit_rounds_fee_to_zero() {
        // floor(1 * 1 / 10_000) = 0 — fees round down (favors user, not vault).
        let (net, fee) = apply_fee_bps(1, 1).unwrap();
        assert_eq!(net, 1);
        assert_eq!(fee, 0);
    }

    #[test]
    fn one_bps_at_threshold_charges_one_unit() {
        // First gross at which a 1-bps fee actually accrues.
        let (net, fee) = apply_fee_bps(10_000, 1).unwrap();
        assert_eq!(net, 9_999);
        assert_eq!(fee, 1);
    }

    #[test]
    fn max_bps_takes_entire_amount_and_rejects_zero_net() {
        // 100% fee leaves the user with 0 — must fail closed, not silently
        // forward a zero-amount transfer to the next CPI.
        let e = apply_fee_bps(1_000, 10_000).unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::ZeroAmountFlow));
    }

    #[test]
    fn near_max_bps_keeps_one_unit() {
        // 99.99% fee on 1M USDC leaves 100 to user.
        let (net, fee) = apply_fee_bps(1_000_000, 9_999).unwrap();
        assert_eq!(fee, 999_900);
        assert_eq!(net, 100);
    }

    #[test]
    fn zero_gross_rejected() {
        // Upstream guards ZeroAmountFlow before we get here; defense-in-depth.
        let e = apply_fee_bps(0, 100).unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::ZeroAmountFlow));
    }

    #[test]
    fn u64_max_with_valid_bps_fits_via_u128_widening() {
        // The whole point of widening to u128 before mul: u64::MAX * 10_000
        // would overflow u64 by ~14 bits. u128 has plenty of headroom.
        let (net, fee) = apply_fee_bps(u64::MAX, 10).unwrap();
        // 10 bps = 0.1%; fee ≈ u64::MAX / 1000.
        assert!(fee > 0);
        assert!(net > 0);
        assert_eq!(net.checked_add(fee).unwrap(), u64::MAX);
    }

    #[test]
    fn u64_max_with_one_bps_yields_minimal_fee() {
        let (net, fee) = apply_fee_bps(u64::MAX, 1).unwrap();
        // fee = floor(u64::MAX / 10_000)
        assert_eq!(fee, u64::MAX / 10_000);
        assert_eq!(net, u64::MAX - fee);
    }

    #[test]
    fn out_of_range_bps_overflows_u64_and_returns_fee_overflow() {
        // `validate()` rejects bps>10_000 at the config layer, but
        // `apply_fee_bps` is the last line of defense if that invariant ever
        // breaks: u64::MAX * 20_000 / 10_000 = 2*u64::MAX, which can't fit
        // back in u64 → FeeOverflow (NOT silent truncation).
        let e = apply_fee_bps(u64::MAX, 20_000).unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::FeeOverflow));
    }

    #[test]
    fn validate_accepts_zero_and_max_fees() {
        let cfg = RelayerConfig {
            authority: Pubkey::default(),
            pending_authority: None,
            usdc_mint: Pubkey::default(),
            onyc_mint: Pubkey::default(),
            fee_vault: Pubkey::default(),
            bump: 0,
            relayer_authority_bump: 0,
            deposit_fee_bps: 0,
            withdraw_fee_bps: 10_000,
        };
        cfg.validate().unwrap();
    }

    #[test]
    fn validate_rejects_above_max() {
        let cfg = RelayerConfig {
            authority: Pubkey::default(),
            pending_authority: None,
            usdc_mint: Pubkey::default(),
            onyc_mint: Pubkey::default(),
            fee_vault: Pubkey::default(),
            bump: 0,
            relayer_authority_bump: 0,
            deposit_fee_bps: 10_001,
            withdraw_fee_bps: 0,
        };
        let e = cfg.validate().unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::FeeBpsTooHigh));
    }

    /// **Backward-compatibility guard.** Borsh serialises an enum variant as
    /// its source-order index (1 byte for ≤256 variants). The relayer
    /// program ID is shared across mainnet/devnet/localnet, so any
    /// already-allocated `Flow` PDA from a prior deploy stores its
    /// `FlowStatus` as 0 (`Claimed`) or 1 (`Swapped`). Reordering the
    /// enum — even just inserting `RedemptionPending` between them —
    /// would shift `Swapped` to tag 2 and silently corrupt every existing
    /// PDA on read. This test fails before any such reorder ships.
    #[test]
    fn flow_status_borsh_tag_invariant() {
        // For payload-less enums in Rust, `as u8` returns the source-order
        // discriminant, which is exactly what borsh emits as the variant tag.
        assert_eq!(FlowStatus::Claimed as u8, 0, "Claimed must stay tag 0");
        assert_eq!(FlowStatus::Swapped as u8, 1, "Swapped must stay tag 1");
        assert_eq!(
            FlowStatus::RedemptionPending as u8,
            2,
            "RedemptionPending must be appended (tag 2), not inserted"
        );
    }

    /// `RedemptionTracker` shape guard: the sidecar must hold the four
    /// withdraw-chain fields that `claim_redemption_usdc` will rely on.
    /// Borsh round-trip is exercised end-to-end via Anchor's account loader
    /// in the LiteSVM tests.
    #[test]
    fn redemption_tracker_holds_withdraw_chain_state() {
        let flow = Pubkey::new_unique();
        let req = Pubkey::new_unique();
        let tracker = RedemptionTracker {
            flow,
            redemption_request: req,
            usdc_ata_pre_balance: 1_000_000,
            onyc_amount_in: 999_500,
            payer: Pubkey::new_unique(),
            bump: 253,
        };
        assert_eq!(tracker.flow, flow);
        assert_eq!(tracker.redemption_request, req);
        assert_eq!(tracker.usdc_ata_pre_balance, 1_000_000);
        assert_eq!(tracker.onyc_amount_in, 999_500);
    }

    /// `Flow` byte-stability guard. The withdraw redesign deliberately
    /// avoids touching `Flow`'s fields so already-allocated PDAs stay
    /// loadable. If anyone ever changes this, `Flow::INIT_SPACE` shifts
    /// and that's the cue to design a versioned migration first.
    ///
    /// Numbers: 32 (fogo_sender) + 1 (FlowStatus tag) + 8 (amount) + 32
    /// (payer) + 1 (bump) = 74. (Anchor's 8-byte account discriminator is
    /// added separately by `init` and not counted here.)
    #[test]
    fn flow_init_space_is_unchanged_by_redesign() {
        assert_eq!(Flow::INIT_SPACE, 74, "Flow layout must not shift");
    }

    /// Compile-time-style guard for the OnRe instruction discriminators.
    /// Every constant in `constants.rs` that claims to be a sighash is
    /// re-derived here from `sha256("global:" + name)[..8]`. If OnRe ever
    /// renames an instruction (or someone fat-fingers a constant), this
    /// test fires before any CPI ships.
    ///
    /// Spec ref: `docs/WITHDRAW_REDESIGN.md` §4.1.
    #[test]
    fn onre_instruction_discriminators_match_anchor_sighash() {
        use crate::constants::{
            ONRE_CANCEL_REDEMPTION_REQUEST_IX, ONRE_CREATE_REDEMPTION_REQUEST_IX,
            ONRE_TAKE_OFFER_IX,
        };

        fn sighash(name: &str) -> [u8; 8] {
            let preimage = format!("global:{name}");
            let digest = solana_sha256_hasher::hashv(&[preimage.as_bytes()]);
            let mut out = [0u8; 8];
            out.copy_from_slice(&digest.to_bytes()[..8]);
            out
        }

        assert_eq!(
            sighash("take_offer_permissionless"),
            ONRE_TAKE_OFFER_IX,
            "ONRE_TAKE_OFFER_IX no longer matches sha256('global:take_offer_permissionless')[..8]"
        );
        assert_eq!(
            sighash("create_redemption_request"),
            ONRE_CREATE_REDEMPTION_REQUEST_IX,
            "ONRE_CREATE_REDEMPTION_REQUEST_IX no longer matches sha256('global:create_redemption_request')[..8]"
        );
        assert_eq!(
            sighash("cancel_redemption_request"),
            ONRE_CANCEL_REDEMPTION_REQUEST_IX,
            "ONRE_CANCEL_REDEMPTION_REQUEST_IX no longer matches sha256('global:cancel_redemption_request')[..8]"
        );
    }

    /// Pins the OnRe `create_redemption_request` `redemption_request` slot
    /// index. `request_redemption_onyc` reads `tracker.redemption_request`
    /// from `ctx.remaining_accounts[<this index>]` post-CPI and trusts OnRe's
    /// `init` constraint to seed-validate it. If OnRe ever reorders the
    /// `Accounts` struct (extremely unlikely — would be a breaking change for
    /// every integrator), this index shifts and we'd silently bind the wrong
    /// account. This test reminds us to update the constant in lockstep.
    ///
    /// Source of truth (verified at session start, 2026-04):
    /// `onre-finance/onre-sol::programs/onreapp/src/instructions/redemption/
    /// create_redemption_request.rs` — `state(0), redemption_offer(1),
    /// redemption_request(2), redeemer(3), ...`
    #[test]
    fn onre_create_redemption_request_redemption_request_index_pinned() {
        use crate::constants::ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX;
        assert_eq!(ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX, 2);
    }

    /// Same shape as the create-side index pin above, for OnRe's
    /// `cancel_redemption_request`. `cancel_redemption_onyc` reads the
    /// key at this index post-CPI to assert it equals the
    /// `tracker.redemption_request` we recorded at create time.
    #[test]
    fn onre_cancel_redemption_request_redemption_request_index_pinned() {
        use crate::constants::ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX;
        assert_eq!(ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX, 2);
    }

    /// The deposit-leg authority MUST derive to a different address than
    /// the relayer authority, otherwise the two would share an associated
    /// USDC ATA and the deposit-vs-redemption isolation that defends
    /// `claim_redemption_usdc`'s delta math collapses. The seed strings
    /// being distinct guarantees distinct PDAs since `find_program_address`
    /// is collision-resistant; this test pins the seed strings themselves.
    #[test]
    fn deposit_and_relayer_seeds_are_distinct() {
        use crate::constants::{DEPOSIT_AUTHORITY_SEED, RELAYER_SEED};
        assert_ne!(DEPOSIT_AUTHORITY_SEED, RELAYER_SEED);
        assert_eq!(DEPOSIT_AUTHORITY_SEED, b"deposit_authority");
        assert_eq!(RELAYER_SEED, b"relayer");
    }
}
