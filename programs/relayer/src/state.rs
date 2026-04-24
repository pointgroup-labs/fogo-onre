use anchor_lang::prelude::*;

use crate::constants::{CONFIG_SEED, FEE_TIMELOCK_SLOTS};
use crate::error::RelayerError;

/// The only long-lived state in this program.
///
/// `authority` is a cold/admin key used only for governance. All operational
/// instructions are permissionless — recipients are VAA-bound, amounts are
/// flow-bound, and CPI targets are compile-time constants.
///
/// **Layout-change hazard (operator-accepted).** `pending_fee` was
/// appended to this struct, growing `INIT_SPACE`. Any `RelayerConfig`
/// PDA created by a *previous* build of this program — on **any**
/// cluster (localnet, devnet, mainnet) under the same program ID
/// declared in `Anchor.toml` — is now under-sized, and every
/// instruction that takes `Account<'info, RelayerConfig>` will fail
/// to deserialize the stale bytes until the account is reallocated
/// and zero-filled (Borsh `Option::None` = `0u8`).
///
/// **No migration instruction ships in this build.** The deployer's
/// accepted recovery for any cluster that already holds a
/// pre-rollout PDA is to close it out-of-band (e.g. via a one-shot
/// upgrade carrying a temporary realloc ix, or by re-`initialize`
/// after closing) before invoking any operational instruction. See
/// `docs/PRE_DEPLOY_CHECKLIST.md` §1.6.
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

    /// Staged fee *increase*, auto-promoted on the next `configure`
    /// call once `pending_fee.ready_slot` has elapsed.
    ///
    /// `None` ⟺ no proposal in flight. Invariant when `Some`: at least
    /// one inner leg is `Some`. Maintained in `configure` by collapsing
    /// to `None` whenever the last inner field clears, so
    /// `pending_fee.is_some()` is the canonical "is anything staged?"
    /// check at every other call site.
    ///
    /// Decreases never use this field — they apply instantly in
    /// `configure`. The `FEE_TIMELOCK_SLOTS` window (~2 days) is the
    /// user's guarantee: a watcher who sees a staged raise has a full
    /// epoch to claim/withdraw at the old rate before promotion.
    pub pending_fee: Option<PendingFee>,
}

/// Bundled pending fee proposal. See `RelayerConfig::pending_fee` for the
/// non-empty invariant.
#[derive(InitSpace, AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct PendingFee {
    /// `None` → deposit leg unaffected by this proposal.
    /// `Some(bps)` → staged deposit-fee increase, takes effect at `ready_slot`.
    pub deposit_fee_bps: Option<u16>,

    /// Same as above for the withdraw leg.
    pub withdraw_fee_bps: Option<u16>,

    /// Earliest `Clock::slot` at which `configure`'s auto-promote step
    /// will move this bundle onto the live fields.
    /// Always `now + FEE_TIMELOCK_SLOTS` at proposal time, MAX-extended
    /// by any subsequent raise so a follow-up never shortens the window.
    pub ready_slot: u64,
}

impl PendingFee {
    /// Both inner legs cleared. The handler collapses the surrounding
    /// `Option` to `None` whenever this returns `true`, so the canonical
    /// "is anything staged?" check at every other call site is
    /// `RelayerConfig.pending_fee.is_some()`.
    pub fn is_empty(&self) -> bool {
        self.deposit_fee_bps.is_none() && self.withdraw_fee_bps.is_none()
    }
}

impl RelayerConfig {
    pub const SEEDS: &'static [u8] = CONFIG_SEED;

    pub fn validate(&self) -> Result<()> {
        require!(self.deposit_fee_bps <= 10_000, RelayerError::FeeBpsTooHigh);
        require!(self.withdraw_fee_bps <= 10_000, RelayerError::FeeBpsTooHigh);
        if let Some(p) = &self.pending_fee {
            require!(!p.is_empty(), RelayerError::EmptyPendingFee);
            if let Some(bps) = p.deposit_fee_bps {
                require!(bps <= 10_000, RelayerError::FeeBpsTooHigh);
            }
            if let Some(bps) = p.withdraw_fee_bps {
                require!(bps <= 10_000, RelayerError::FeeBpsTooHigh);
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

    /// If a staged proposal has reached its `ready_slot`, move each `Some`
    /// inner leg onto the live field and clear the bundle. No-op when
    /// nothing is staged or the timelock hasn't elapsed.
    ///
    /// Run at the top of `configure::handler` so a follow-up "decrease"
    /// in the same call compares against the just-promoted value rather
    /// than the stale one — otherwise the asymmetric branch could
    /// silently flip and the decrease would route through the staging
    /// path instead of applying instantly.
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

    /// Apply the asymmetric proposal rule to the deposit-fee leg:
    /// `proposed <= current` applies instantly; `proposed > current` is
    /// staged into `pending_fee` with a MAX-extended `ready_slot`. See
    /// `propose_fee_change` for the shared logic.
    pub fn propose_deposit_fee(&mut self, proposed: u16, now: u64) -> Result<()> {
        propose_fee_change(
            proposed,
            &mut self.deposit_fee_bps,
            &mut self.pending_fee,
            |p| &mut p.deposit_fee_bps,
            now,
        )
    }

    /// Same shape as `propose_deposit_fee` for the withdraw leg.
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

/// Pure asymmetric proposal logic, mutating in place:
///
/// - `proposed <= *live`: apply instantly + clear THIS leg in the bundle.
///   If that empties the bundle, drop it to `None` (maintains the
///   `PendingFee::is_empty` invariant).
/// - `proposed >  *live`: bundle gains/updates this leg; `ready_slot`
///   MAX-extends so a follow-up raise never shortens an in-flight window.
///
/// Range validation (`proposed <= 10_000`) is intentionally deferred to
/// `validate()` at the end of the handler.
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

/// Returns `(net, fee)` where `fee = floor(gross * bps / 10_000)`.
///
/// `try_from` is defense-in-depth — under the `validate()` invariant
/// `fee_u128 <= gross`, so the cast can't overflow today, but enforcing
/// locally turns a future invariant violation into `FeeOverflow` instead of
/// silent truncation.
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
/// **Field set is byte-stable.** Withdraw-chain redemption tracking lives
/// in the sidecar `RedemptionTracker` PDA below; nothing else attaches
/// to `Flow`. Already-allocated `Flow` PDAs from prior deploys must
/// continue to load.
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

    /// Minimal `RelayerConfig` fixture for fee-related tests. All
    /// non-fee fields are zero/default — they aren't read by `validate`
    /// or `promote_pending_fee_if_ready`.
    fn cfg_with(
        deposit_fee_bps: u16,
        withdraw_fee_bps: u16,
        pending_fee: Option<PendingFee>,
    ) -> RelayerConfig {
        RelayerConfig {
            authority: Pubkey::default(),
            pending_authority: None,
            usdc_mint: Pubkey::default(),
            onyc_mint: Pubkey::default(),
            fee_vault: Pubkey::default(),
            bump: 0,
            relayer_authority_bump: 0,
            deposit_fee_bps,
            withdraw_fee_bps,
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
        cfg_with(0, 10_000, None).validate().unwrap();
    }

    #[test]
    fn validate_rejects_above_max() {
        let e = cfg_with(10_001, 0, None).validate().unwrap_err();
        assert_eq!(err_code(e), code_of(RelayerError::FeeBpsTooHigh));
    }

    #[test]
    fn validate_rejects_empty_pending_fee_bundle() {
        // Invariant: a `Some` bundle must have at least one inner leg set.
        // The handler maintains this via collapse-on-empty, but `validate`
        // is the catch-all if a future code path bypasses it.
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
        // ready_slot still in the future → live untouched, bundle preserved.
        let bundle = pending_both(200, 250, NOW + 10);
        let mut cfg = cfg_with(100, 150, Some(bundle));
        cfg.promote_pending_fee_if_ready(NOW);
        assert_eq!((cfg.deposit_fee_bps, cfg.withdraw_fee_bps), (100, 150));
        assert_eq!(cfg.pending_fee, Some(bundle), "bundle preserved verbatim");
    }

    #[test]
    fn promote_ripe_moves_both_legs_and_clears_bundle() {
        // ready_slot has elapsed → both staged values land on live, bundle
        // collapses to None. This is the auto-promote that the dropped
        // `apply_pending_fee` ix used to perform.
        let mut cfg = cfg_with(100, 150, Some(pending_both(200, 250, NOW - 1)));
        cfg.promote_pending_fee_if_ready(NOW);
        assert_eq!((cfg.deposit_fee_bps, cfg.withdraw_fee_bps), (200, 250));
        assert_eq!(cfg.pending_fee, None);
    }

    #[test]
    fn promote_ripe_with_one_leg_unstaged_preserves_other_live() {
        // Only deposit staged. Withdraw live value must pass through
        // unchanged — the `if let Some(w)` guard skips the unstaged leg.
        let mut cfg = cfg_with(100, 150, Some(pending_deposit_only(200, NOW - 1)));
        cfg.promote_pending_fee_if_ready(NOW);
        assert_eq!((cfg.deposit_fee_bps, cfg.withdraw_fee_bps), (200, 150));
        assert_eq!(cfg.pending_fee, None);
    }

    #[test]
    fn propose_decrease_applies_instantly_and_clears_only_its_leg() {
        // Both legs staged. Decreasing deposit must clear deposit staging
        // but leave withdraw staging untouched.
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
        // Only deposit staged. Restating current value clears that leg,
        // and since the other leg is empty the bundle collapses to None
        // (the `is_empty` check inside propose_fee_change does this inline,
        // not a handler-tail filter).
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
        // No prior bundle: ready_slot = now + DELAY exactly.
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
        // Existing window expires far in future. A second raise *now*
        // must keep the longer window — watcher lead-time can never silently shrink.
        let far_future = NOW + FEE_TIMELOCK_SLOTS + 10_000;
        let mut cfg = cfg_with(100, 0, Some(pending_deposit_only(200, far_future)));
        cfg.propose_deposit_fee(300, NOW).unwrap();
        let p = cfg.pending_fee.unwrap();
        assert_eq!(p.deposit_fee_bps, Some(300), "latest authority intent wins");
        assert_eq!(p.ready_slot, far_future, "window not shortened");
    }

    #[test]
    fn propose_second_increase_with_elapsed_window_uses_fresh_delay() {
        // Existing ready_slot is in the past — should have been promoted
        // already. A new raise gets a fresh full-DELAY window so authority
        // can't piggyback on an elapsed window to apply instantly.
        let mut cfg = cfg_with(100, 0, Some(pending_deposit_only(200, NOW - 1)));
        cfg.propose_deposit_fee(300, NOW).unwrap();
        let p = cfg.pending_fee.unwrap();
        assert_eq!(p.deposit_fee_bps, Some(300));
        assert_eq!(p.ready_slot, NOW + FEE_TIMELOCK_SLOTS);
    }

    #[test]
    fn propose_cross_leg_increase_shares_bundle() {
        // Deposit raise already staged; withdraw raise lands now. Same
        // bundle gains the second leg, ready_slot MAX-extends.
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

    /// `Flow` byte-stability guard. The withdraw redesign and the
    /// fee-timelock work both deliberately avoided touching `Flow`'s
    /// fields so already-allocated PDAs stay loadable. Staged fee state
    /// lives on `RelayerConfig.pending_fee`, not on `Flow`. If anyone
    /// ever changes this, `Flow::INIT_SPACE` shifts and that's the cue
    /// to design a versioned migration first.
    ///
    /// Numbers: 32 (fogo_sender) + 1 (FlowStatus tag) + 8 (amount) + 32
    /// (payer) + 1 (bump) = 74. (Anchor's 8-byte account discriminator
    /// is added separately by `init` and not counted here.)
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
}
