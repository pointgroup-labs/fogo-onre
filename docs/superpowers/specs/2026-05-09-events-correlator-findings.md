# Findings: relayer events as user-flow correlator

**Date:** 2026-05-09
**Source:** `programs/relayer/src/events.rs` and 8 `emit!` sites under `programs/relayer/src/instructions/`
**Status:** Phase 0 / Task 0.1 complete (per `docs/superpowers/plans/2026-05-09-onchain-transfer-history.md`)

## Executive finding

**A user-derivable correlator exists on-chain.** `fogo_sender: [u8; 32]` — the user's FOGO-side pubkey — is emitted in 5 of 8 relayer events. `flow: Pubkey` is emitted in all 8 events and ties events within a single flow together. Flow-centric history with exact (non-heuristic) correlation is achievable, **provided the events can be queried server-side or via a third-party indexer**.

This invalidates the worst-case scenario assumed in the plan's path-decision matrix ("no correlator exists"). The correct branch of the matrix is now: **correlator exists, surfacing strategy is the open question.**

## Event inventory

8 Anchor events, all emitted from relayer instructions:

| Event | Emitted from | `flow` | `ntt_inbox_item` | `fogo_sender` | `amount` | Other fields |
|---|---|:-:|:-:|:-:|:-:|---|
| `UsdcClaimed` | `claim_usdc.rs:194` | ✓ | ✓ | ✓ | ✓ | — |
| `OnycSwapped` | `swap_usdc_to_onyc.rs:69` | ✓ | — | — | — | gross/fee/net |
| `OnycLocked` | `lock_onyc.rs:95` | ✓ | ✓ | ✓ | ✓ | — |
| `OnycUnlocked` | `unlock_onyc.rs:88` | ✓ | ✓ | ✓ | ✓ | — |
| `RedemptionRequested` | `request_redemption_onyc.rs:92` | ✓ | — | — | — | redemption_request, gross/fee/net, usdc_ata_pre_balance |
| `RedemptionCancelled` | `cancel_redemption_onyc.rs:70` | ✓ | — | — | — | redemption_request, returned_onyc_amount |
| `RedemptionClaimed` | `claim_redemption_usdc.rs:62` | ✓ | — | — | — | redemption_request, onyc_amount_in, usdc_received |
| `UsdcSentToUser` | `send_usdc_to_user.rs:64` | ✓ | ✓ | ✓ | ✓ | — |

## Correlator structure

Two pubkey-shaped correlators, with complementary properties:

1. **`fogo_sender: [u8; 32]`** — the user's pubkey on FOGO, source of the original NTT message. Present in **events that anchor the user side of a flow**:
   - `UsdcClaimed` — deposit's first Solana-side step
   - `OnycLocked` — deposit's last Solana-side step
   - `OnycUnlocked` — withdraw's first Solana-side step
   - `UsdcSentToUser` — withdraw's last Solana-side step

   This is exactly the set needed to identify a user's flows: presence in **either** the first or last event of a flow is sufficient to find it. The middle events (`OnycSwapped`, `RedemptionRequested`, `RedemptionCancelled`, `RedemptionClaimed`) intentionally omit `fogo_sender` because they're internal accounting steps.

2. **`flow: Pubkey`** — relayer-side `Flow` PDA, present in **all 8 events**. Once you've found one event for a flow (via `fogo_sender`), you can join all sibling events by `flow`. This gives you the complete event timeline for that flow.

## Flow timelines reconstructable from events

### Deposit (USDC.s on FOGO → ONyc on FOGO)

| # | Event | Anchored on | What it tells the UI |
|---|---|---|---|
| 1 | `UsdcClaimed` | `fogo_sender`, `flow`, `ntt_inbox_item`, `amount` | Deposit accepted on Solana, USDC released to relayer custody |
| 2 | `OnycSwapped` | `flow`, gross/fee/net | OnRe swap completed, fee deducted |
| 3 | `OnycLocked` | `fogo_sender`, `flow`, `ntt_inbox_item`, `amount` | ONyc locked into NTT for transfer to FOGO; final Solana-side step |
| 4 | (FOGO mint, no relayer event — cranker job) | — | User's ONyc ATA credited on FOGO |

Status derivable from event set:
- `{ UsdcClaimed }` → swap pending
- `{ UsdcClaimed, OnycSwapped }` → ONyc lock pending
- `{ UsdcClaimed, OnycSwapped, OnycLocked }` → bridging back to FOGO; user-facing "in flight"
- `{ ... + FOGO ONyc mint observed }` → delivered

### Withdraw (ONyc on FOGO → USDC.s on FOGO)

| # | Event | Anchored on | What it tells the UI |
|---|---|---|---|
| 1 | `OnycUnlocked` | `fogo_sender`, `flow`, `ntt_inbox_item`, `amount` | ONyc unlocked from NTT custody on Solana |
| 2 | `RedemptionRequested` | `flow`, `redemption_request`, gross/fee/net, `usdc_ata_pre_balance` | OnRe redemption queued |
| 3 | `RedemptionCancelled` *(branch)* | `flow`, `redemption_request`, `returned_onyc_amount` | Authority cancelled the redemption — terminal failure path |
| 3' | `RedemptionClaimed` *(branch)* | `flow`, `redemption_request`, `onyc_amount_in`, `usdc_received` | OnRe paid out USDC; redemption claimed |
| 4 | `UsdcSentToUser` | `fogo_sender`, `flow`, `ntt_inbox_item`, `amount` | USDC bridging back to FOGO; final Solana-side step |
| 5 | (FOGO mint, no relayer event — cranker job) | — | User's USDC.s ATA credited on FOGO |

Status derivable from event set:
- `{ OnycUnlocked }` → awaiting OnRe queue
- `{ OnycUnlocked, RedemptionRequested }` → in OnRe queue (this is the legitimately-multi-day state Codex flagged)
- `{ ..., RedemptionCancelled }` → **terminal failure**, returned_onyc_amount tells the UI exactly how much ONyc went back to user
- `{ ..., RedemptionClaimed }` → bridging back to FOGO
- `{ ..., RedemptionClaimed, UsdcSentToUser }` → bridge in flight on FOGO
- `{ ... + FOGO USDC.s mint observed }` → delivered

**Key observation:** The withdraw flow has a real `failed` state on chain (`RedemptionCancelled`). The plan's "no `failed` state" note is now obsolete — events provide an exact failure signal.

## Surfacing strategies — what this unlocks

The correlator exists. The remaining question is **how to query for events filtered by `fogo_sender`**, since Solana doesn't index event fields natively. Three viable strategies:

### Strategy 1: Wormholescan / third-party Solana event index

If Wormholescan (or Helius / Triton enhanced APIs) decodes Anchor events from the relayer program with field-level access, querying `events where fogo_sender == userPubkey` becomes a single API call. **Validation pending in Task 0.2.**

If they only decode NTT events but not relayer events, partial correlation is still possible:
- Wormholescan/NTT gives you origin (FOGO `transfer_burn`) and destination (FOGO `release_inbound_mint`) per VAA.
- Relayer events fill in the middle — but only if separately queryable.

### Strategy 2: Custom indexer

Subscribe to the relayer program ID via Solana websocket, decode events from logs, store rows keyed on `(fogo_sender, flow)`. Expose `GET /api/history?owner=<pubkey>`. This is genuinely tractable now that the event schema is known to be event-sourcing-friendly:
- Schema is stable (Anchor events are versioned by IDL).
- Correlator is explicit.
- All flow states are derivable from event presence.
- Failure mode (`RedemptionCancelled`) is surfaced.

Estimate: 2-3 days for a minimal indexer (websocket subscriber + Postgres + REST), assuming no hardening or auth.

### Strategy 3: Client-side log scanning

`getSignaturesForAddress(RELAYER_PROGRAM_ID)` paginated, fetch each tx, decode logs. **Impractical at scale** — relayer is invoked for every user's flow, not just this user's. Cost is O(all relayer activity) per user page-load.

This strategy was implicitly assumed unviable in the plan, and remains so.

## Implications for the plan

The plan's path-decision matrix should be updated:

| Wormholescan covers FOGO+NTT | Wormholescan/Helius decodes relayer events | Recommended path |
|---|---|---|
| Yes | Yes | **Path A — Wormholescan, full flow + middle states** (best UX possible client-only) |
| Yes | No | **Path A* — Wormholescan, origin/destination only, status from time + destination presence** (degraded but acceptable) |
| No | (any) | **Path D — Custom relayer-event indexer** (newly attractive given clean schema; replaces "Path B activity-list" as the realistic fallback) |

The original Path B ("event-list, no synthesis") is downgraded to a last-resort fallback — there's no good reason to ship it if Path A or Path D is achievable, given that a correlator exists.

## Specific events.rs improvements worth considering (out of scope, just observations)

These are observations, not recommendations to implement:

1. **`OnycSwapped` lacks `fogo_sender`.** Acceptable because it's joinable via `flow`, but if events are ever consumed by an indexer that processes them out-of-order or with partial visibility, including `fogo_sender` here would improve robustness.

2. **`RedemptionRequested` includes `usdc_ata_pre_balance`** which is operational metadata, not user-facing. Indexers can ignore it.

3. **Bridge fee in deposit flow surfaces in `OnycSwapped` (gross/fee/net), but the FOGO-side burn amount the user signed is not echoed.** An indexer correlating to the FOGO-side `transfer_burn` will need to fetch that separately or accept the amount from `UsdcClaimed` (which equals the post-NTT-decimal-trim amount, not the pre-trim user input).

4. **`UsdcSentToUser` and `OnycLocked` both echo `amount` and `ntt_inbox_item`,** giving an indexer two independent confirmations of the destination-leg amount. Useful for validation.

## Recommended next actions

1. **Update the plan's path-decision matrix** to reflect the new finding (correlator exists; Path B downgraded to last resort, Path D added).
2. **Proceed with Task 0.2** — Wormholescan validation. The decision now hinges on whether Wormholescan decodes relayer events; if yes, ship Path A in days; if no, decide between Path A* and Path D based on UX standards.
3. **Pre-emptively scope a Path D mini-spec** before Task 0.2 returns. The relayer-event indexer is now the most-likely fallback and deserves a sketched architecture so Phase 0 can wrap up with a real choice rather than a placeholder.

## Conclusion

The relayer's event schema is significantly more friendly to history-feature work than the plan assumed. `fogo_sender` is an explicit user-derivable correlator emitted on flow boundaries; `flow` is a within-flow join key; the schema even surfaces a real `failed` state via `RedemptionCancelled`. The architectural problem is no longer "is correlation possible" but "where do we host the index that exposes correlator-filtered queries to the client" — a smaller, better-defined question.
