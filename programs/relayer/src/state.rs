use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, FEE_TIMELOCK_SLOTS, MAX_FEE_BPS};
use crate::error::RelayerError;

/// `authority` gates governance only; flow instructions are permissionless.
#[account]
#[derive(InitSpace)]
pub struct RelayerConfig {
    pub usdc_mint: Pubkey,
    pub onyc_mint: Pubkey,

    pub authority: Pubkey,
    pub fee_vault: Pubkey,

    pub deposit_fee_bps: u16,
    pub withdraw_fee_bps: u16,

    pub relayer_authority_bump: u8,
    pub bump: u8,

    /// Promoted to `authority` by `accept_authority` (two-step handoff).
    pub pending_authority: Option<Pubkey>,

    /// Staged fee *increase*, auto-promoted on next `configure` once
    /// `ready_slot` elapses. Decreases bypass this.
    pub pending_fee: Option<PendingFee>,
}

#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct PendingFee {
    pub deposit_fee_bps: Option<u16>,

    pub withdraw_fee_bps: Option<u16>,

    /// MAX-extended on later raises so a follow-up never shortens the window.
    pub ready_slot: u64,
}

impl PendingFee {
    pub fn is_empty(&self) -> bool {
        self.deposit_fee_bps.is_none() && self.withdraw_fee_bps.is_none()
    }
}

impl RelayerConfig {
    pub const SEEDS: &'static [u8] = CONFIG_SEED;

    pub fn validate(&self) -> Result<()> {
        require!(
            self.deposit_fee_bps <= MAX_FEE_BPS,
            RelayerError::FeeBpsTooHigh
        );
        require!(
            self.withdraw_fee_bps <= MAX_FEE_BPS,
            RelayerError::FeeBpsTooHigh
        );
        if let Some(p) = &self.pending_fee {
            require!(!p.is_empty(), RelayerError::EmptyPendingFee);
            if let Some(bps) = p.deposit_fee_bps {
                require!(bps <= MAX_FEE_BPS, RelayerError::FeeBpsTooHigh);
            }
            if let Some(bps) = p.withdraw_fee_bps {
                require!(bps <= MAX_FEE_BPS, RelayerError::FeeBpsTooHigh);
            }
        }
        Ok(())
    }

    pub fn apply_deposit_fee(&self, gross: u64) -> Result<(u64, u64)> {
        apply_fee_bps(gross, self.deposit_fee_bps)
    }

    pub fn apply_withdraw_fee(&self, gross: u64) -> Result<(u64, u64)> {
        apply_fee_bps(gross, self.withdraw_fee_bps)
    }

    /// Run at the top of `configure::handler` so a same-call decrease
    /// compares against the just-promoted value, not the stale one.
    pub fn promote_pending_fee_if_ready(&mut self, now: u64) {
        let Some(p) = self.pending_fee else { return };
        if now < p.ready_slot {
            return;
        }
        if let Some(d) = p.deposit_fee_bps {
            self.deposit_fee_bps = d;
        }
        if let Some(w) = p.withdraw_fee_bps {
            self.withdraw_fee_bps = w;
        }
        self.pending_fee = None;
    }

    pub fn propose_deposit_fee(&mut self, proposed: u16, now: u64) -> Result<()> {
        propose_fee_change(
            proposed,
            &mut self.deposit_fee_bps,
            &mut self.pending_fee,
            |p| &mut p.deposit_fee_bps,
            now,
        )
    }

    pub fn propose_withdraw_fee(&mut self, proposed: u16, now: u64) -> Result<()> {
        propose_fee_change(
            proposed,
            &mut self.withdraw_fee_bps,
            &mut self.pending_fee,
            |p| &mut p.withdraw_fee_bps,
            now,
        )
    }
}

/// Asymmetric:
/// - `proposed <= live`: apply instantly, clear this leg.
/// - `proposed >  live`: stage; `ready_slot` MAX-extends so a follow-up
///   raise can't shorten an in-flight window.
fn propose_fee_change(
    proposed: u16,
    live: &mut u16,
    bundle: &mut Option<PendingFee>,
    leg: fn(&mut PendingFee) -> &mut Option<u16>,
    now: u64,
) -> Result<()> {
    if proposed <= *live {
        *live = proposed;
        if let Some(p) = bundle {
            *leg(p) = None;
            if p.is_empty() {
                *bundle = None;
            }
        }
        return Ok(());
    }

    let new_ready = now
        .checked_add(FEE_TIMELOCK_SLOTS)
        .ok_or(RelayerError::FeeOverflow)?;

    let p = bundle.get_or_insert(PendingFee {
        deposit_fee_bps: None,
        withdraw_fee_bps: None,
        ready_slot: new_ready,
    });
    p.ready_slot = p.ready_slot.max(new_ready);
    *leg(p) = Some(proposed);
    Ok(())
}

/// Returns `(net, fee)` with `fee = floor(gross * bps / 10_000)`.
/// `try_from` defense-in-depth: surfaces a future invariant break as
/// `FeeOverflow` instead of silent truncation.
pub(crate) fn apply_fee_bps(gross: u64, bps: u16) -> Result<(u64, u64)> {
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
    Claimed,
    Swapped,
    /// Withdraw chain only: ONyc forwarded to OnRe, awaiting fulfillment.
    /// Appended (not inserted) so existing `Flow` PDAs keep tags 0/1.
    RedemptionPending,
}

/// One-shot receipt binding an inbound bridge message to a FOGO wallet.
/// Replay protection lives in the per-VAA NTT claim account. Field set
/// is byte-stable — older PDAs must keep deserializing.
#[account]
#[derive(InitSpace)]
pub struct Flow {
    /// Originator on FOGO; outbound recipient on the return leg.
    pub fogo_sender: [u8; 32],

    pub status: FlowStatus,

    pub amount: u64,

    pub payer: Pubkey,

    pub bump: u8,
}

/// Singleton mutex for the in-flight withdraw-chain redemption.
/// `init` here fails if another redemption is mid-flight, blocking the
/// USDC-delta race.
#[account]
#[derive(InitSpace)]
pub struct RedemptionTracker {
    pub flow: Pubkey,

    /// OnRe `RedemptionRequest` PDA; polled for closure as fulfillment signal.
    pub redemption_request: Pubkey,

    /// Relayer USDC ATA balance pre-CPI; `claim_redemption_usdc` uses
    /// post-fulfillment delta vs this.
    pub usdc_ata_pre_balance: u64,

    /// Audit-trail only — net-of-fee ONyc sent to OnRe.
    pub onyc_amount_in: u64,

    /// Pays for init, receives rent on close.
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
        (re as u32) + ERROR_CODE_OFFSET
    }

    fn cfg_with(
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
        pending_fee: Option<PendingFee>,
    ) -> RelayerConfig {
        RelayerConfig {
            usdc_mint: Pubkey::default(),
            onyc_mint: Pubkey::default(),
            authority: Pubkey::default(),
            fee_vault: Pubkey::default(),
            deposit_fee_bps,
            withdraw_fee_bps,
            relayer_authority_bump: 0,
            bump: 0,
            pending_authority: None,
            pending_fee,
        }
    }

    #[test]
    fn zero_bps_passes_through_full_amount() {
        let (net, fee) = apply_fee_bps(1_000_000, 0).unwrap();
        assert_eq!(net, 1_000_000);
        assert_eq!(fee, 0);
    }

    #[test]
    fn one_bps_one_unit_rounds_fee_to_zero() {
        // Fees round down (favors user, not vault).
        let (net, fee) = apply_fee_bps(1, 1).unwrap();
        assert_eq!(net, 1);
        assert_eq!(fee, 0);
    }

    #[test]
    fn one_bps_at_threshold_charges_one_unit() {
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
        // u64::MAX * 10_000 would overflow u64 by ~14 bits; u128 has headroom.
        let (net, fee) = apply_fee_bps(u64::MAX, 10).unwrap();
        assert!(fee > 0);
        assert!(net > 0);
        assert_eq!(net.checked_add(fee).unwrap(), u64::MAX);
    }

    #[test]
    fn u64_max_with_one_bps_yields_minimal_fee() {
        let (net, fee) = apply_fee_bps(u64::MAX, 1).unwrap();
        assert_eq!(fee, u64::MAX / 10_000);
        assert_eq!(net, u64::MAX - fee);
    }

    #[test]
    fn out_of_range_bps_overflows_u64_and_returns_fee_overflow() {
        // Last line of defense if `validate()`'s bps≤10_000 invariant breaks:
        // overflow surfaces as FeeOverflow, NOT silent truncation.
        let e = apply_fee_bps(u64::MAX, 20_000).unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::FeeOverflow));
    }

    #[test]
    fn validate_accepts_zero_and_max_fees() {
        cfg_with(0, MAX_FEE_BPS, None).validate().unwrap();
    }

    #[test]
    fn validate_rejects_above_max() {
        let e = cfg_with(MAX_FEE_BPS + 1, 0, None).validate().unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::FeeBpsTooHigh));
    }

    #[test]
    fn validate_rejects_empty_pending_fee_bundle() {
        // Catch-all if a future code path bypasses the inline collapse.
        let empty_bundle = PendingFee {
            deposit_fee_bps: None,
            withdraw_fee_bps: None,
            ready_slot: 0,
        };
        let e = cfg_with(0, 0, Some(empty_bundle)).validate().unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::EmptyPendingFee));
    }

    fn pending_both(d: u16, w: u16, ready: u64) -> PendingFee {
        PendingFee {
            deposit_fee_bps: Some(d),
            withdraw_fee_bps: Some(w),
            ready_slot: ready,
        }
    }
    fn pending_deposit_only(d: u16, ready: u64) -> PendingFee {
        PendingFee {
            deposit_fee_bps: Some(d),
            withdraw_fee_bps: None,
            ready_slot: ready,
        }
    }

    const NOW: u64 = 1_000_000;

    #[test]
    fn promote_no_bundle_is_noop() {
        let mut cfg = cfg_with(100, 150, None);
        cfg.promote_pending_fee_if_ready(NOW);
        assert_eq!((cfg.deposit_fee_bps, cfg.withdraw_fee_bps), (100, 150));
        assert_eq!(cfg.pending_fee, None);
    }

    #[test]
    fn promote_not_yet_ripe_keeps_bundle() {
        let bundle = pending_both(200, 250, NOW + 10);
        let mut cfg = cfg_with(100, 150, Some(bundle));
        cfg.promote_pending_fee_if_ready(NOW);
        assert_eq!((cfg.deposit_fee_bps, cfg.withdraw_fee_bps), (100, 150));
        assert_eq!(cfg.pending_fee, Some(bundle), "bundle preserved verbatim");
    }

    #[test]
    fn promote_ripe_moves_both_legs_and_clears_bundle() {
        let mut cfg = cfg_with(100, 150, Some(pending_both(200, 250, NOW - 1)));
        cfg.promote_pending_fee_if_ready(NOW);
        assert_eq!((cfg.deposit_fee_bps, cfg.withdraw_fee_bps), (200, 250));
        assert_eq!(cfg.pending_fee, None);
    }

    #[test]
    fn promote_ripe_with_one_leg_unstaged_preserves_other_live() {
        let mut cfg = cfg_with(100, 150, Some(pending_deposit_only(200, NOW - 1)));
        cfg.promote_pending_fee_if_ready(NOW);
        assert_eq!((cfg.deposit_fee_bps, cfg.withdraw_fee_bps), (200, 150));
        assert_eq!(cfg.pending_fee, None);
    }

    #[test]
    fn propose_decrease_applies_instantly_and_clears_only_its_leg() {
        let mut cfg = cfg_with(
            100,
            100,
            Some(pending_both(200, 250, NOW + FEE_TIMELOCK_SLOTS)),
        );
        cfg.propose_deposit_fee(50, NOW).unwrap();
        assert_eq!(cfg.deposit_fee_bps, 50, "decrease applies instantly");
        let p = cfg.pending_fee.expect("withdraw staging should survive");
        assert_eq!(p.deposit_fee_bps, None, "deposit staging cleared");
        assert_eq!(p.withdraw_fee_bps, Some(250), "withdraw staging untouched");
    }

    #[test]
    fn propose_restating_current_clears_leg_and_collapses_empty_bundle() {
        let mut cfg = cfg_with(
            100,
            0,
            Some(pending_deposit_only(200, NOW + FEE_TIMELOCK_SLOTS)),
        );
        cfg.propose_deposit_fee(100, NOW).unwrap();
        assert_eq!(cfg.deposit_fee_bps, 100);
        assert_eq!(cfg.pending_fee, None, "empty bundle collapses inline");
    }

    #[test]
    fn propose_increase_stages_with_timelock() {
        let mut cfg = cfg_with(100, 0, None);
        cfg.propose_deposit_fee(200, NOW).unwrap();
        assert_eq!(cfg.deposit_fee_bps, 100, "live unchanged on raise");
        let p = cfg.pending_fee.expect("staged proposal");
        assert_eq!(p.deposit_fee_bps, Some(200));
        assert_eq!(p.withdraw_fee_bps, None);
        assert_eq!(p.ready_slot, NOW + FEE_TIMELOCK_SLOTS);
    }

    #[test]
    fn propose_second_increase_extends_but_never_shortens_window() {
        // Watcher lead-time can never silently shrink.
        let far_future = NOW + FEE_TIMELOCK_SLOTS + 10_000;
        let mut cfg = cfg_with(100, 0, Some(pending_deposit_only(200, far_future)));
        cfg.propose_deposit_fee(300, NOW).unwrap();
        let p = cfg.pending_fee.unwrap();
        assert_eq!(p.deposit_fee_bps, Some(300), "latest authority intent wins");
        assert_eq!(p.ready_slot, far_future, "window not shortened");
    }

    #[test]
    fn propose_second_increase_with_elapsed_window_uses_fresh_delay() {
        // Authority can't piggyback on an elapsed window to apply instantly.
        let mut cfg = cfg_with(100, 0, Some(pending_deposit_only(200, NOW - 1)));
        cfg.propose_deposit_fee(300, NOW).unwrap();
        let p = cfg.pending_fee.unwrap();
        assert_eq!(p.deposit_fee_bps, Some(300));
        assert_eq!(p.ready_slot, NOW + FEE_TIMELOCK_SLOTS);
    }

    #[test]
    fn propose_cross_leg_increase_shares_bundle() {
        let earlier = NOW + FEE_TIMELOCK_SLOTS - 1_000;
        let mut cfg = cfg_with(100, 100, Some(pending_deposit_only(200, earlier)));
        cfg.propose_withdraw_fee(300, NOW).unwrap();
        let p = cfg.pending_fee.unwrap();
        assert_eq!(p.deposit_fee_bps, Some(200), "deposit leg untouched");
        assert_eq!(p.withdraw_fee_bps, Some(300), "withdraw leg added");
        assert_eq!(p.ready_slot, NOW + FEE_TIMELOCK_SLOTS, "MAX-extended");
    }

    #[test]
    fn propose_fee_overflow_on_pathological_clock() {
        // u64::MAX as `now` would overflow `now + DELAY`. Surface as
        // FeeOverflow rather than silent wrap.
        let mut cfg = cfg_with(100, 0, None);
        let e = cfg.propose_deposit_fee(200, u64::MAX).unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::FeeOverflow));
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
        assert_eq!(FlowStatus::Claimed as u8, 0, "Claimed must stay tag 0");
        assert_eq!(FlowStatus::Swapped as u8, 1, "Swapped must stay tag 1");
        assert_eq!(
            FlowStatus::RedemptionPending as u8,
            2,
            "RedemptionPending must be appended (tag 2), not inserted"
        );
    }

    /// `RedemptionTracker` shape guard: must hold the four withdraw-chain
    /// fields `claim_redemption_usdc` relies on.
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

    /// `Flow` byte-stability guard. If anyone ever changes the layout,
    /// `Flow::INIT_SPACE` shifts and that's the cue to design a versioned
    /// migration first.
    #[test]
    fn flow_init_space_is_unchanged_by_redesign() {
        assert_eq!(Flow::INIT_SPACE, 74, "Flow layout must not shift");
    }

    /// `RelayerConfig` byte-stability guard. Same rationale as the
    /// `Flow` pin: a shift here means the singleton config PDA layout
    /// has changed and any non-rebuilt relayer would deserialize garbage
    /// out of `relayer_config`. Forces a deliberate migration plan
    /// before the layout drifts.
    #[test]
    fn relayer_config_init_space_is_unchanged_by_redesign() {
        assert_eq!(
            RelayerConfig::INIT_SPACE,
            182,
            "RelayerConfig layout must not shift"
        );
    }

    /// Re-derives every claimed sighash from `sha256("global:" + name)[..8]`.
    /// Fires before any CPI ships if OnRe renames an instruction or a
    /// constant gets fat-fingered.
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

    /// Pins the OnRe `create_redemption_request.redemption_request` slot index.
    /// If OnRe reorders the `Accounts` struct, this index shifts and we'd
    /// silently bind the wrong account.
    #[test]
    fn onre_create_redemption_request_redemption_request_index_pinned() {
        use crate::constants::ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX;
        assert_eq!(ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX, 2);
    }

    /// Same shape as the create-side index pin above, for OnRe's
    /// `cancel_redemption_request`.
    #[test]
    fn onre_cancel_redemption_request_redemption_request_index_pinned() {
        use crate::constants::ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX;
        assert_eq!(ONRE_CANCEL_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX, 2);
    }
}
