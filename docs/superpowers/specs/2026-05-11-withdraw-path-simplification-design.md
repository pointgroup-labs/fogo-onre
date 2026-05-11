# Withdraw-Path Simplification — Design Spec

**Date:** 2026-05-11
**Supersedes:** `2026-05-10-jupiter-fallback-on-onre-cancel-design.md` (additive design abandoned in favor of subtractive)
**Status:** Approved for implementation

## Problem

The withdraw chain ships with four on-chain handlers around OnRe's
`create_redemption_request` / `fulfill_redemption_request` flow:
`request_redemption_onyc`, `claim_redemption_usdc`,
`cancel_redemption_onyc`, plus the permissionless fallback
`redeem_onyc`. That fallback was designed as recovery for cancel
events but, given OnRe's policy that **redemptions are KYC-gated and
the relayer PDA cannot complete KYC**, the request/claim/cancel
handlers are dead code in mainnet operation. The fallback is, de
facto, the primary path.

Carrying the dead path forward has real cost: dormant code lives in
the audit scope, `RedemptionTracker` singleton state and three
sibling-handler mutex constraints exist solely to defend a path that
never runs, the `FlowStatus::RedemptionPending` intermediate state
adds machine surface for no operational benefit, the 2-day
`REDEEM_COOLDOWN_SLOTS` artifact of OnRe's design constrains a path
that doesn't have OnRe's pacing constraint, and operators must learn
a runbook for cancel-event recovery that doesn't materialize.

## Design

**Delete the OnRe-path handlers and replace with a single
permissionless swap handler.** ONyc → USDC conversion goes through
any swap program (Jupiter, Phoenix, Raydium, OTC market-makers, etc.)
under NAV-anchored slippage protection. If OnRe later opens an
allowlist for the relayer PDA, the OnRe handlers can be re-introduced
via program upgrade — the relayer is `BPFLoaderUpgradeable` precisely
for this kind of pivot.

### New handler: `swap_onyc_to_usdc`

Signature:

```rust
pub fn swap_onyc_to_usdc<'info>(
    ctx: Context<'info, SwapOnycToUsdc<'info>>,
    swap_ix_data: Vec<u8>,
) -> Result<()>
```

Permissionless. Cranker constructs the swap instruction; the program
validates that the swap respects the NAV floor and runs under bounded
authority. Behavior:

1. **Fee deduction.** Withdraw fee in ONyc, transferred from
   `flow.onyc_amount_in` to `fee_vault`. (Mirrors current
   `request_redemption_onyc` fee semantics.)
2. **NAV floor computation.** Read OnRe `Offer` PDA, parse active
   vector, compute `gross_expected = redemptionExpectedOut(...)` and
   `floor = applySlippageFloor(gross_expected, MAX_SLIPPAGE_BPS)`.
   Reuses existing helpers from `redeem_onyc.rs`.
3. **Bounded SPL Approve.** PDA signs an Approve scoped to
   `flow.onyc_amount_in - fee` (post-fee remainder) — capping how much
   ONyc the downstream swap can pull regardless of what the swap_ix
   tries.
4. **Plain `invoke` of swap_ix.** No PDA signer threaded through; the
   swap program runs without delegated authority over the relayer
   PDA's accounts.
5. **Post-balance check.** USDC delta on relayer-authority USDC ATA
   must be `>= floor`. Otherwise revert with
   `SwapBelowNavFloor`.
6. **State flip.** `Flow.status: Claimed → Swapped`. No intermediate
   `RedemptionPending` state.

### State machine

Before: `Claimed → RedemptionPending → Swapped` with
`cancel_redemption_onyc` back-edge to `Claimed`.
After: `Claimed → Swapped`. No back-edge needed; no intermediate.

### Constants

- `MAX_SLIPPAGE_BPS`: `50 → 10`. Tightening reflects that under the
  swap-only design this constant *is* the security boundary, not a
  secondary check. 10 bps is the operational floor we expect ONyc/USDC
  to clear at typical redemption sizes.
- `REDEEM_COOLDOWN_SLOTS`: delete. Cooldown was inherited from OnRe's
  request pacing; the swap path doesn't have that constraint, and
  cooldown actively hurts on a stuck redemption (operators want to
  retry, not wait).

### Deletions and deprecations

**Deleted on-chain (`programs/relayer/src/`):**
- `instructions/request_redemption_onyc.rs`
- `instructions/claim_redemption_usdc.rs`
- `instructions/cancel_redemption_onyc.rs`
- `instructions/redeem_onyc.rs`
- `lib.rs`: four `#[program]` entry points removed, one added

**Kept as deprecated (cannot delete — byte-stability invariants):**
- `state.rs::FlowStatus::RedemptionPending` — borsh tag 2 is pinned
  by `flow_status_borsh_tag_invariant` test. Removing the variant
  would shift no other tags (it's last in source order), but historical
  `Flow` PDAs with status=2 must remain deserializable in case any
  exist post-drain. **Mark `#[deprecated]`, keep the variant.**
- `state.rs::RedemptionTracker` struct + `REDEMPTION_TRACKER_SEED` —
  `redemption_tracker_holds_withdraw_chain_state` test pins shape;
  any orphaned tracker PDA must still deserialize for inspection.
  **Mark `#[deprecated]`, keep the struct and seed.**
- `state.rs::RelayerConfig.last_redeem_slot` —
  `relayer_config_init_space_is_unchanged_by_redesign` pins
  `INIT_SPACE = 190`. Removing the field shifts layout and corrupts
  every existing config PDA. **Keep the field, rename to
  `_reserved_was_last_redeem_slot` (or `#[deprecated]`) to surface the
  intent.**
- `constants.rs::REDEEM_COOLDOWN_SLOTS` — referenced by deleted
  handler only. **Safe to delete** once `redeem_onyc.rs` is gone.

**Kept as defense-in-depth (free protection, no carrying cost):**
- `redemption_tracker: SystemAccount<'info>` constraints on
  `claim_usdc`, `send_usdc_to_user`, `swap_usdc_to_onyc`. After the
  handler deletion, no path ever instantiates `RedemptionTracker`,
  so the `SystemAccount` constraint (which asserts the account is
  uninitialized / lamports=0) is always trivially satisfied. **Keep
  these constraints** — if a future change reintroduces tracker init
  by accident, the absent-required constraint surfaces the regression
  immediately rather than silently allowing a half-built singleton.

**Migration constraint — pre-deploy drain gate (hard gate):**
Any in-flight `Flow` with status `RedemptionPending` becomes
permanently stuck once `claim_redemption_usdc` and `redeem_onyc` are
deleted. There is no migration path. **Production must drain all
`RedemptionPending` flows via the existing handlers before deploying
this change.** Verification: scan all `Flow` PDAs, assert none have
status=2. Document in the deploy checklist.

**SDK (`packages/sdk/`):**
- Builders for the four deleted handlers
- `redemptionTrackerPda` derivation
- Add `swapOnycToUsdc` builder + client method

**Cranker (`packages/cranker/`):**
- `src/relayer/request-redemption-onyc.ts`
- `src/relayer/claim-redemption-usdc.ts`
- `src/relayer/cancel-redemption-handler.ts`
- `src/relayer/redeem-onyc-quote.ts` *(can be kept and re-targeted)*
- Add `src/relayer/swap-onyc-to-usdc.ts` (Jupiter quote + ix construction + submit)
- Update `scan.ts` / `enumerate.ts` dispatch table to swap-handler

**CLI (`packages/cli/`):**
- Drop `request-redemption-onyc`, `claim-redemption-usdc`,
  `cancel-redemption-onyc`, `redeem-onyc` subcommands
- Add `swap-onyc-to-usdc` subcommand

**Tests:**
- Delete e2e suites for the four deleted handlers
- Add e2e + unit suites for `swap_onyc_to_usdc`
- Update withdraw-chain integration test to use the new path

**Scripts:**
- Delete `scripts/recover-redeem-onyc.ts` (cancel-event recovery script — no longer applicable)

### What's kept

- `onre-nav.ts` (TS) and `onre.rs` (Rust) NAV math — used by new handler
- `MAX_SLIPPAGE_BPS` mirror test between Rust and TS
- Drift tripwires on OnRe `Offer` layout
- All deposit-chain handlers and state — untouched

## Security argument

The simplified design has a smaller threat surface because the
attack-defending mechanisms collapse to one boundary:

- **NAV floor at 10 bps.** Bounds extractable value per call,
  regardless of swap program identity. A compromised cranker
  submitting a malicious swap_ix cannot drain more than 10 bps from
  the expected NAV.
- **Bounded SPL Approve.** Caps how much ONyc the swap program can
  pull, regardless of what its instruction claims.
- **Plain `invoke`.** No PDA signer threaded through the swap CPI —
  the swap program has no authority over the relayer's ATAs beyond
  the explicit Approve.

These three are independent. All three would have to fail for a
malicious swap_ix to extract value. The previous design had cooldown
and OnRe-path fallback on top, but those mechanisms didn't defend
against attacks the three above already cover — they defended against
a *different* threat (an attacker repeatedly draining at floor), which
is now bounded by Jupiter's economic friction (slippage on consecutive
trades against the same pool).

## Operational gates

Before merging:

1. **Empirical liquidity check.** Confirm ONyc/USDC depth on Jupiter
   clears 10 bps at the redemption sizes expected in production. If
   not, either widen the floor (loosens security) or block the design
   pending deeper liquidity. This is the one open question that can
   only be answered with production data.
2. **Operator runbook update.** Document that the withdraw chain is
   now: `claim_usdc → swap_usdc_to_onyc → lock_onyc` (deposit) and
   `unlock_onyc → swap_onyc_to_usdc → send_usdc_to_user` (withdraw).
   No cancel-event branch.
3. **Upgrade authority finalization gate.** Unchanged from existing
   deploy checklist.

## Non-goals

- Reintroducing the OnRe redemption path. If OnRe ships allowlisting
  for the relayer PDA, a separate spec re-adds the handlers via
  program upgrade.
- Defending against Jupiter-aggregator-wide outage. The cranker can
  route through any swap program; aggregator-specific failure is a
  routing concern, not an on-chain concern.
- Multi-router on-chain selection. Cranker picks the route off-chain;
  the on-chain handler is router-agnostic by construction.
