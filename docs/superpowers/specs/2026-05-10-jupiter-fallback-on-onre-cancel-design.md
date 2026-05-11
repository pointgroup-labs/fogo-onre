# Jupiter Fallback for OnRe-Rejected Withdraws — Design Spec

**Date:** 2026-05-10
**Status:** Approved for planning
**Triggering incident:** Stuck withdraw flow `FEjqpMcDJJpZRRFUnThF874GKVUUhx3ohnB9EepqNcBj`
(0.198 ONyc net). OnRe canceled the redemption (tx `5cCWsic1…`). Flow is at
`RedemptionPending`, `redemption_request` PDA closed, ONyc refunded to
`onyc_ata`, USDC delta is zero, `claim_redemption_usdc` keeps reverting with
`ZeroAmountFlow`. The singleton `RedemptionTracker` is still held → all other
withdraws are blocked.

## Problem

The 4-leg withdraw chain has no recovery path for OnRe-rejected redemptions:

- `cancel_redemption_onyc` cannot run — its CPI hits OnRe's
  `cancel_redemption_request`, which fails with `AccountNotInitialized` on a
  PDA that OnRe already closed.
- `claim_redemption_usdc` cannot run — it requires `usdc_delta > 0`.
- The singleton `RedemptionTracker` (one per program, seed
  `["redemption_tracker"]`) is the on-chain mutex for the entire withdraw
  chain. As long as the stranded flow holds it, every new withdraw blocks at
  pre-flight 3 of `request_redemption_onyc`.

This is not a one-off: any OnRe rejection (manual, programmatic, downstream
liquidity issue) leaves the relayer in this state. We need a recovery primitive.

## Goals

1. **Unblock stranded flows** by routing through Jupiter v6 to convert refunded
   ONyc → USDC, reaching the same `Swapped` FSM state as the happy path.
2. **Preserve the singleton mutex semantics** — the new path must close the
   tracker exactly like the happy path.
3. **Bound the blast radius.** The fallback is a recovery tool, not an
   automatic alternative venue. It does not change the happy path.
4. **Avoid touching the existing `claim_redemption_usdc`.** Donation-grief on
   that handler is a real but separate vulnerability tracked in a follow-up PR
   (it requires a `RedemptionTracker` schema change).

## Non-goals

- Replacing OnRe as the primary redemption venue.
- Multi-venue routing (Phoenix, Orca, OTC). Naming reserves `_via_jupiter`
  intentionally; future venues get their own handlers.
- Auto-execution by the cranker. The handler is **authority-gated**; an
  operator runs the recovery CLI subcommand explicitly.
- Fixing donation-grief on `claim_redemption_usdc`. Separate PR.

## Architecture

One new Anchor handler:

```
swap_redemption_via_jupiter (AUTHORITY-GATED)
```

FSM unchanged. Both `claim_redemption_usdc` (happy path) and the new handler
(recovery path) target `Swapped`. The cranker continues to drive the happy
path; the recovery path is operator-invoked via CLI.

## Why authority-gated

This was the most consequential design pivot, made in response to the codex
adversarial review. A permissionless variant would expose:

- **Caller-controlled `min_usdc_out`** as a sandwich/MEV vector. A griefer
  passes a tiny `min_usdc_out`, lands the tx, locks `flow.amount` to a
  much-smaller-than-NAV value, and the user receives less USDC than the
  refunded ONyc was worth.
- **Race amplification** between competing crankers, both of which fetch fresh
  Jupiter quotes and build txs.
- **Donation-grief amplification** — the `usdc_ata` precondition could be
  flipped by a 1-lamport USDC transfer.

Authority-gating collapses all three at once: the operator picks the moment,
picks the slippage, and there is exactly one race participant.

## Preconditions (validated on-chain, in order)

1. `signer == relayer_config.authority`
2. `tracker.flow == flow_key` (the per-flow `outflight` PDA)
3. `flow.status == RedemptionPending`
4. `redemption_request.key() == tracker.redemption_request`
5. `redemption_request` is closed:
   `lamports() == 0 && data_is_empty() && owner == system_program`
6. Jupiter program ID is the pinned constant.
7. The Jupiter ix discriminator equals `SHARED_ACCOUNTS_ROUTE`. **All other
   Jupiter v6 variants are rejected** (`route`, `route_with_token_ledger`,
   `shared_accounts_route_with_token_ledger`). Pinning to one variant freezes
   the account layout we audit.
8. The Jupiter ix data parses to:
   - `in_amount == tracker.onyc_amount_in` (no partial fills),
   - `platform_fee_bps == 0` (no third party skim),
   - `quoted_out_amount >= min_usdc_out` (defense-in-depth on top of the
     post-CPI delta check).
9. The Jupiter route accounts wire to *our* ATAs:
   - `route.source_token_account == onyc_ata`
   - `route.destination_token_account == usdc_ata`
   - `route.source_mint == onyc_mint`
   - `route.destination_mint == usdc_mint`
10. `onyc_ata.amount >= tracker.onyc_amount_in` (refunded ONyc is here).

## Handler signature

```rust
pub fn handler<'info>(
    ctx: Context<'info, SwapRedemptionViaJupiter<'info>>,
    min_usdc_out: u64,
) -> Result<()>
```

`onyc_amount_in` is **not** a parameter — it is read from
`tracker.onyc_amount_in`. (Codex finding: any caller-supplied amount is an
attack surface when it's also written into the Jupiter ix data on-chain.)

## Accounts

Fixed accounts (Anchor `Accounts` struct):

- `authority: Signer`
- `relayer_config: Account<RelayerConfig>` — `has_one = authority`
- `relayer_authority: AccountInfo` — PDA, seed `["relayer"]`
- `onyc_mint: Account<Mint>`
- `usdc_mint: Account<Mint>`
- `onyc_ata: Account<TokenAccount>` — owner = `relayer_authority`,
  mint = `onyc_mint`
- `usdc_ata: Account<TokenAccount>` — owner = `relayer_authority`,
  mint = `usdc_mint`
- `ntt_inbox_item: AccountInfo` — used to derive the flow PDA
- `outflight_flow: Account<Flow>` — `mut`, seed
  `["outflight", ntt_inbox_item.key().as_ref()]`
- `redemption_tracker: Account<RedemptionTracker>` — `mut`,
  `close = payer_for_close`, seed `["redemption_tracker"]`
- `payer_for_close: AccountInfo` — `mut` (rent recipient = original payer
  recorded in tracker)
- `redemption_request: AccountInfo` — must be closed (validated in handler)
- `token_program: Program<Token>`
- `jupiter_program: AccountInfo` — `address = JUPITER_V6_PROGRAM_ID`

`remaining_accounts`: the Jupiter `shared_accounts_route` account list,
passed through unchanged. Validated by position before CPI.

## Logic (sequential)

```
1. Validate authority, FSM gates, request closed (preconditions 1–5, 10).
2. Snapshot:
     onyc_before = onyc_ata.amount  // re-read after Anchor account load
     usdc_before = usdc_ata.amount
3. Parse the Jupiter ix from `instruction_data` arg + remaining_accounts:
     - Discriminator == SHARED_ACCOUNTS_ROUTE (precondition 7)
     - in_amount == tracker.onyc_amount_in (precondition 8)
     - platform_fee_bps == 0
     - quoted_out_amount >= min_usdc_out
4. Validate route accounts by position (precondition 9).
5. CPI Jupiter `shared_accounts_route` via invoke_relayer_signed
   (existing helper signs under `relayer_authority` PDA).
6. Reload onyc_ata, usdc_ata.
7. Require:
     onyc_consumed = onyc_before - onyc_after
     usdc_received = usdc_after  - usdc_before
     onyc_consumed == tracker.onyc_amount_in   // exact, not >=
     usdc_received >= min_usdc_out
8. Mutate state (only after all post-CPI checks pass):
     flow.amount = usdc_received
     flow.status = Swapped
9. Anchor closes tracker via `close = payer_for_close`.
10. emit RedemptionSwappedViaJupiter { flow, onyc_consumed, usdc_received,
                                       min_usdc_out }
```

Mutation order matters: if Jupiter succeeds but the consumed/received
invariants fail, we revert. We never write `flow.status = Swapped` on a
half-completed swap.

## Slippage policy

- Hard-coded floor: `MAX_SLIPPAGE_BPS = 50` (0.5%) in `constants.rs`.
- Operator computes `min_usdc_out` off-chain from a fresh Jupiter `/quote`
  call, multiplies by `(10_000 - slippage_bps) / 10_000`, and passes it.
- Defense-in-depth: the on-chain handler also requires
  `quoted_out_amount >= min_usdc_out` (the quoted amount inside the parsed
  Jupiter ix), so a stale quote whose `quoted_out` is below `min_usdc_out`
  reverts before the swap fires.

## Compute budget & tx size

- Set `ComputeBudgetProgram.setComputeUnitLimit(1_000_000)` in the CLI
  subcommand by default; document override knob.
- Use ALTs for the Jupiter route accounts. Mainnet Jupiter `shared_accounts_route`
  multi-hop routes regularly need ALTs to fit under 1232B; the CLI builds a
  v0 transaction with a Jupiter-supplied ALT.
- If a route doesn't fit even with ALTs: operator picks a different route
  (fewer hops) from the Jupiter quote API. We do not split the swap across
  txs — atomicity with our state mutation is required.

## Race classifier additions

`packages/cranker/src/relayer/race-classifier.ts` `RACE_TABLE` gains:

- `6004` (`ZeroAmountFlow`) — only on the recovery path's USDC delta check;
  classified as benign-race when emitted by `swap_redemption_via_jupiter`.
- `AccountNotInitialized` (Anchor `3012`) — recovery race where another
  authority key already closed the tracker.
- `AccountDiscriminatorMismatch` (Anchor `3002`) — same scenario.

Note: the recovery path is authority-gated, so two-cranker races are
impossible. These entries are defensive against operator-double-fire.

## Cancel-fee tolerance

OnRe's current cancel path refunds the full ONyc amount (no fee — verified
against the on-chain `cancel_redemption_request` body). Precondition 10 uses
`>=`, not exact equality, leaving headroom if OnRe ever introduces a fixed
or variable cancel fee. **If OnRe adds a percentage cancel fee, this design
needs a tolerance parameter** — flagged for monitoring; not handled now.

## Daemon behavior

The cranker does **not** auto-fire this handler. In the redemption-pending
advancer, on detecting:

- `redemption_request closed && usdc_delta == 0 && onyc_returned`,

the daemon:

- emits a structured `OnReRedemptionCanceled` log,
- increments a `redemption_canceled_total` Prometheus counter,
- pages the operator,
- noops the flow (keeps the tracker held; recovery is manual).

The operator runs `pnpm cli cranker swap-redemption-via-jupiter --flow <pubkey>
--slippage-bps 50 --confirm` (subcommand under
`packages/cli/src/commands/cranker.ts`).

## Naming

`swap_redemption_via_jupiter` — venue-specific by design. If a future venue
is added (Phoenix, Orca direct, OTC), it ships as a separate handler
(`swap_redemption_via_phoenix` etc.). No abstract `swap_redemption_external`
— the audit surface for "any external venue" is unbounded.

## Out of scope (separate follow-ups)

1. **Donation-grief on `claim_redemption_usdc`.** A 1-lamport USDC transfer
   into `usdc_ata` between OnRe's fulfill and our claim corrupts
   `flow.amount`. Fix requires `RedemptionTracker` schema change to record
   the OnRe-paid USDC amount directly, not infer it from ATA delta. Tracked
   separately.
2. **Recovering the existing stranded flow** `FEjqp…NcBj`. Once this design
   ships and is deployed, the operator runs the new CLI subcommand against
   that flow first.

## Implementation order

1. On-chain handler + tests (LiteSVM + real Jupiter `.so` fixture, sha256-pinned
   in `pinBinaryFixtures()`).
2. SDK: `swapRedemptionViaJupiter` builder in `RelayerClient`, including the
   Jupiter-quote fetch helper.
3. Race classifier additions.
4. Daemon detection + alerting (no auto-fire).
5. CLI subcommand.
6. Mainnet recovery of `FEjqp…NcBj`.

## References

- Codex adversarial review: 16 findings folded in (4 Critical, 9 Major,
  3 Minor). Top 3 critical: caller-controlled `min_usdc_out`, donation-grief
  on existing path, Jupiter v6 variant ambiguity.
- Existing handlers for pattern: `programs/relayer/src/instructions/claim_redemption_usdc.rs`,
  `cancel_redemption_onyc.rs`.
- Existing race classifier: `packages/cranker/src/relayer/race-classifier.ts`.
- OnRe cancel verification: tx `5cCWsic1DiSmczSNRPh6HcavqtBmEnF8P471nVhzP66i7K8chTSGJkfGnupZHZ3WVhAWD5LXNz96KMexFMUEnXEb`.
