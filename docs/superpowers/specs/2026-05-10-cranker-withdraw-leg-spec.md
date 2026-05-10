# Cranker Withdraw-Leg Implementation Spec

> **Status:** design only — no code in this document.
> **Audience:** whoever picks up the implementation PR.
> **Scope:** add withdraw-leg drive logic to the cranker daemon
> (`packages/cranker/`) and CLI (`packages/cli/src/commands/cranker.ts`)
> so a user-initiated FOGO ONyc burn flows end-to-end to USDC delivery
> on Solana without manual intervention. **No on-chain code changes.**

---

## 1. Problem statement

The cranker daemon and CLI implement only the deposit leg today. A user
who initiates a withdraw on FOGO sees the burn land, the
`release_wormhole_outbound` ix publish a VAA (post the webapp fix in
commit `4344b44`), guardians attest — and then nothing happens on
Solana. There is no automated process that will:

1. Submit the inbound VAA to the Solana ONyc NTT manager (`redeem` +
   `release_inbound_unlock`) and create the relayer's outflight `Flow`
   PDA via `unlock_onyc`.
2. Burn the unlocked ONyc into OnRe via `request_redemption_onyc` to
   queue a USDC redemption.
3. Once OnRe fulfills the queue and closes its `RedemptionRequest` PDA,
   call `claim_redemption_usdc` to record the USDC delta on the flow
   and release the singleton `RedemptionTracker` mutex.
4. Call `send_usdc_to_user` to NTT-lock USDC back to the user's FOGO
   wallet, closing the flow.

The on-chain handlers in `programs/relayer/src/instructions/` exist;
the SDK has builders (`client.unlockOnyc`, `client.requestRedemptionOnyc`,
`client.claimRedemptionUsdc`, `client.sendUsdcToUser`); the daemon
enumerator already harvests the ONyc emitter and tags VAAs as
`leg='withdraw'`. The gap is the per-status dispatch handlers + the
plumbing that propagates the leg tag through scan dispatch + a CLI
mirror so operators can hand-crank during incidents.

---

## 2. Existing architecture this fits into

### 2.1 On-chain shape (already deployed; no changes)

Withdraw chain, recorded in `programs/relayer/src/state.rs`:

| Step | Ix                          | Pre-status | Post-status         | PDA writes/closes                                                                        |
|------|-----------------------------|------------|---------------------|------------------------------------------------------------------------------------------|
| 1    | `unlock_onyc`               | (none)     | `Claimed`           | inits `outflight_flow` (`["outflight", ntt_inbox_item]`)                                 |
| 2    | `request_redemption_onyc`   | `Claimed`  | `RedemptionPending` | inits `redemption_tracker` (singleton `["redemption_tracker"]`); flow.amount := net      |
| 3    | `claim_redemption_usdc`     | `RedemptionPending` | `Swapped` | closes `redemption_tracker` (rent → tracker.payer); flow.amount := USDC delta            |
| 4    | `send_usdc_to_user`         | `Swapped`  | (closes flow)       | closes `outflight_flow` (rent → flow.payer)                                              |

Critical invariants from the on-chain code:

- **`Flow.status` enum is shared between legs.** `FlowStatus::Claimed`
  on a deposit-leg `inflight_flow` PDA means "USDC swept into user
  inbox"; on a withdraw-leg `outflight_flow` PDA it means "ONyc
  unlocked to relayer ATA". `FlowStatus::Swapped` on deposit means
  "USDC→ONyc done"; on withdraw means "ONyc→USDC done". **The status
  alone is not sufficient to pick a dispatch fn.** The PDA seed
  (`"inflight"` vs `"outflight"`) is the disambiguator. This is
  essential because `state.rs:480–488` pins the on-chain enum tag
  layout and explicitly forbids inserting new variants between
  existing ones (would corrupt every existing PDA on read).
- **`RedemptionTracker` is a singleton mutex** (one PDA, no per-flow
  keying). While ANY user's withdraw is in `RedemptionPending`, NO
  other user's `request_redemption_onyc` can succeed — the `init`
  constraint in the handler will fail with Anchor account-already-in-use
  (custom error 0x0). This is intentional: the tracker carries
  `usdc_ata_pre_balance` so `claim_redemption_usdc` can compute the
  USDC delta against a snapshot known to be uncontaminated by other
  flows. The daemon must accept this serialization point as a fact and
  not surface it as a noisy failure.
- **`send_usdc_to_user` requires `redemption_tracker` to be a
  `SystemAccount`** (i.e., closed). This means while ANY redemption is
  in `RedemptionPending`, NO flow's `send_usdc_to_user` can run, even
  if that flow is independently in `Swapped`. The on-chain ordering
  is: previous-flow's `claim_redemption_usdc` (which closes the
  tracker) → any flow's `send_usdc_to_user` → next flow's
  `request_redemption_onyc` (which re-opens the tracker).
- **`unlock_onyc`** parses `fogo_sender` from the
  `ntt_transceiver_message` account (set by the NTT redeem step) and
  computes a balance delta on `onyc_ata` to recover the released
  amount. The `outflight_flow` PDA is keyed on `ntt_inbox_item` (same
  derivation as deposit's `inflight_flow`, different seed prefix).

### 2.2 Daemon shape today (`packages/cranker/src/`)

```
src/
├── daemon.ts            # main loop (reads cancel signal, calls scanAndAdvance)
├── relayer/
│   ├── enumerate.ts     # Wormholescan paging → ScannedFlow[]; harvests both legs
│   ├── scan.ts          # FSM dispatch + per-flow concurrency + retry classifier
│   ├── claim-usdc.ts    # deposit step 1 handler
│   ├── swap-usdc-to-onyc.ts  # deposit step 2
│   ├── lock-onyc.ts     # deposit step 3 (closest pattern to copy)
│   ├── account-layouts.ts
│   ├── race-classifier.ts
│   └── types.ts         # AdvanceContext, AdvanceResult
├── state/
│   ├── flow-state.ts    # per-flow FSM (in-flight / cooldown / poisoned)
│   └── watermarks.ts    # Wormholescan paging floor per (chain, emitter)
└── utils/
    ├── wormhole.ts      # fetchVaaBytes, WORMHOLE_CORE_MAINNET, DEFAULT_NTT_VERSION
    └── ...
```

`scan.ts` exposes:
- `FLOW_STATUSES = ['Pending', 'Claimed', 'Swapped', 'Locked', 'Closed']`
  — type union; **not extended** for `RedemptionPending`.
- `pickAdvanceForStatus(status, fns)` — switch table:
  `Pending → claimUsdc`, `Claimed → swapUsdcToOnyc`,
  `Swapped → lockOnyc`, default `undefined` (skip).
- The `scanAndAdvance` per-flow inner loop chains legs in-tick:
  while a handler returns `kind: 'advanced'`, the loop re-dispatches on
  the new status without paying a scan-interval per leg.

`enumerate.ts` already harvests the ONyc emitter and tags resolutions
with `VAA_LEG.withdraw` — but it then calls `fetchInflightFlow` on
both legs, which is **wrong for withdraws**: withdraw flows live under
`findOutflightFlowPda`, a different seed (`"outflight"`), so this
fetch always 404s and every withdraw VAA gets stamped `status:
'Pending'`. That's fine on the *first* iteration (no flow exists yet),
but once `unlock_onyc` lands, the on-chain status is `Claimed` on the
`outflight` PDA — and the enumerator will keep reporting `Pending`
because it's looking at the wrong PDA. Subsequent dispatches will
re-attempt `unlock_onyc`, which will fail at the `init` constraint
because `outflight_flow` already exists (Anchor 0x0), and the
race-classifier will likely tag this as a retryable error class.

This is the single most important design fix: **the leg tag must
propagate from `enumerate.ts` through `ScannedFlow` into `scan.ts`
dispatch**, and the Flow PDA fetch must be leg-aware.

### 2.3 SDK builders (already implemented; no changes)

From `packages/sdk/src/client.ts`:
- `client.unlockOnyc({ payer, onycMint, ntt_transceiver_message,
   ntt_inbox_item, redeemAccountsLen, ... })` — line 351
- `client.requestRedemptionOnyc({ payer, ... })` — line 438
- `client.claimRedemptionUsdc({ cranker, ... })` — line 485
- `client.sendUsdcToUser({ payer, ... })` — line 398
- `client.fetchOutflightFlow(nttInboxItem)` — line 566
- `client.findOutflightFlowPda` (re-exported) — used at `client.ts:617`

The exact account-list shape passed to each `client.*` builder needs
reverification against the current SDK signatures during
implementation; the high-level point is that the builders exist and
mirror the deposit-leg pattern (account namesake fields + a
`remaining_accounts` blob for the CPI'd program's accounts).

---

## 3. Per-handler design

For each of the four daemon handlers, the spec covers: input,
preconditions checked off-chain (to skip cleanly without paying the
sim cost), the SDK builder call, race classes the
race-classifier needs to learn, idempotency story, and the
`AdvanceResult` shape returned.

### 3.1 `unlockOnyc` (file: `src/relayer/unlock-onyc.ts`)

**Pattern reference:** `claim-usdc.ts` (NTT redeem + relayer CPI in
one tx, with pre-flight account lookups).

**Input** (from dispatch):
- `fogoTx: string` (carried from enumerator)
- `vaaHex?: string` (preferred over fogoTx to avoid Wormholescan RTT)
- `nttProgram = NTT_ONYC_PROGRAM_ID` (override only for tests)

**Off-chain preconditions to check before submitting:**
1. **VAA bytes resolvable.** `fetchVaaBytes` against
   `(chain=51, emitter=ONyc_emitter_PDA, sequence=…)`. If
   Wormholescan 404s, return `kind: 'noop'` with reason "VAA not yet
   attested" — guardians will eventually sign; next scan retries.
2. **Resolve `ntt_inbox_item` PDA** via `resolveNttVaa({ vaaBytes,
   nttProgramId: NTT_ONYC_PROGRAM_ID })`. Note the program-ID switch
   from deposit (USDC manager) — withdraws come back through the ONyc
   manager as inbound on Solana.
3. **Outflight Flow PDA does NOT exist.** Call
   `client.fetchOutflightFlow(nttInboxItem)` and expect a 404. If it
   resolves, the `unlock_onyc` step has already landed and the next
   handler should run on `Claimed`. Return `kind: 'noop'` with reason
   "outflight_flow already exists, status=…".
4. **NTT inbox item PDA does NOT exist** (or, if it exists, has
   amount > 0 and is not yet redeemed). Same deduplication logic as
   `claim-usdc.ts:139–173`. If the inbox item exists but its balance
   has already been swept into the relayer ATA (rare, only via prior
   manual cranking), we cannot recover; return `kind: 'noop'` with
   "inbox-item already swept; outflight_flow init would fail".

**SDK call:**
```text
client.unlockOnyc({
  payer:                    keypair.publicKey,
  onycMint:                 cfg.onycMint,
  nttInboxItem:             resolved.nttInboxItem,
  nttTransceiverMessage:    resolved.nttTransceiverMessage,
  redeemAccountsLen:        <split index into remaining_accounts>,
  ...remainingAccounts:     [redeemAccs..., releaseAccs...]   // built via SolanaNtt
})
```

The `remaining_accounts` split mirrors `unlock_onyc.rs:28–34`. The
NTT redeem + release_inbound_unlock account lists come from
`SolanaNtt`'s `createRedeemIx` and `createReleaseInboundUnlockIx`
(check whichever the @wormhole-foundation SDK exposes for v3) —
exactly the pattern `claim-usdc.ts` uses for the USDC manager.

**Race classes** (extend `race-classifier.ts`):
- Anchor `0x0` on `outflight_flow` init → "outflight_flow already
  initialized — another cranker won the race"; demote to `noop`, not
  `error`.
- NTT `InvalidVaaSignature` (or whatever the v3 manager surfaces) → if
  guardian set updated mid-flight, this is recoverable on next scan.
- `InsufficientLamports` on payer → operator alert (not retryable
  without intervention).

**Idempotency:** the on-chain `init` of `outflight_flow` is the dedup
point. Two crankers submitting concurrently will see one win + one
0x0; both leave the chain in a consistent state.

**`AdvanceResult` on success:**
```text
{ kind: 'advanced', signatures: [sig], fromStatus: 'Pending',
  toStatus: 'WithdrawClaimed' }
```

Note: see §3.5 for why the post-status is **not** the bare `'Claimed'`
string — the dispatch table needs a leg-disambiguating value.

**Compute budget:** NTT redeem + release_inbound_unlock + unlock_onyc
relayer CPI is the same shape as deposit's `claim_usdc`, which
empirically fits in the default 200k. Verify via simulation in the
first PR; if it doesn't, prepend a `ComputeBudgetProgram`
`setComputeUnitLimit(400_000)`. The lock-onyc handler does not
top-up; this one shouldn't need to either since no NTT outbound rent
is paid here (that's only on the lock side).

---

### 3.2 `requestRedemptionOnyc` (file: `src/relayer/request-redemption-onyc.ts`)

**Pattern reference:** `swap-usdc-to-onyc.ts` (relayer CPI into OnRe
with no NTT involvement).

**Off-chain preconditions:**
1. **Outflight flow exists with status `Claimed`.** If status is
   `RedemptionPending`, this step already landed → noop. Any other
   status → error (state corruption).
2. **`RedemptionTracker` PDA does NOT exist** (i.e., closed). Fetch
   the singleton at `findRedemptionTrackerPda()`. If it exists,
   another flow is in `RedemptionPending` and OnRe hasn't fulfilled
   yet. Return `kind: 'noop'` with reason "RedemptionTracker singleton
   held by flow=… (waiting on OnRe fulfillment)". **This is the
   normal back-pressure signal**, not an error. The next scan will
   retry; once the held flow advances through `claim_redemption_usdc`,
   the tracker closes and this flow can proceed.
3. **OnRe state shape.** Same OnRe-state account dump pattern as
   `swap-usdc-to-onyc.ts` — Offer PDA, mint authorities, etc. Use the
   same account-layout decoder.

**SDK call:**
```text
client.requestRedemptionOnyc({
  payer:               keypair.publicKey,
  nttInboxItem:        flow.nttInboxItem,
  ...remainingAccounts // OnRe create_redemption_request accounts;
                       // index 2 must be the redemption_request PDA per
                       // ONRE_CREATE_REDEMPTION_REQUEST_REDEMPTION_REQUEST_INDEX
})
```

**Race classes:**
- `RedemptionTracker` `init` 0x0 — caught by precondition 2 above; if
  it fires post-precondition, treat as noop (another cranker won the
  race for the singleton).
- `UnexpectedOnycConsumed` (relayer custom error in
  `request_redemption_onyc.rs:71–74`) — OnRe took more or less ONyc
  than expected. This is a serious mismatch (OnRe-side bug or
  account-list mis-binding). Surface as error, do not retry; this is
  an alert-on-first-sighting class.
- OnRe's own custom errors (queue full, mint paused, etc.) should be
  surfaced verbatim with their numeric code + name. Most are
  retryable; some (e.g., redemption_request slot already taken) are
  benign races.

**Idempotency:** the singleton tracker `init` is the dedup. Combined
with the `Claimed → RedemptionPending` status transition, this step
cannot be replayed.

**`AdvanceResult` on success:**
```text
{ kind: 'advanced', fromStatus: 'WithdrawClaimed',
  toStatus: 'RedemptionPending' }
```

---

### 3.3 `claimRedemptionUsdc` (file: `src/relayer/claim-redemption-usdc.ts`)

**Pattern reference:** `lock-onyc.ts` for the pre-flight pattern
(read on-chain state, decide noop vs proceed); no CPI, pure relayer
ix call.

**Off-chain preconditions:**
1. **Outflight flow exists with status `RedemptionPending`.**
2. **`RedemptionTracker` exists** and `tracker.flow == this flow PDA`.
   If the tracker exists but points at a different flow, this dispatch
   is on the wrong flow — noop with reason "tracker held by other
   flow".
3. **OnRe `redemption_request` PDA is closed.** Fetch
   `tracker.redemption_request`; if `lamports > 0`, OnRe hasn't
   fulfilled yet. Return `kind: 'noop'` with reason "OnRe redemption
   not yet fulfilled (tracker open since slot N)". This is the
   off-chain mirror of the on-chain check at
   `claim_redemption_usdc.rs:38–42`.
4. **`usdc_ata` balance increased over `tracker.usdc_ata_pre_balance`.**
   If the delta is zero or negative, OnRe fulfilled with zero USDC →
   on-chain handler will fail at the `delta > 0` check
   (`claim_redemption_usdc.rs:53`). Surface as error class
   "OnRe fulfilled with zero USDC" — operator alert, not retryable.

**SDK call:**
```text
client.claimRedemptionUsdc({
  cranker:             keypair.publicKey,    // receives tracker rent
  nttInboxItem:        flow.nttInboxItem,
  redemptionRequest:   tracker.redemption_request,
  payerForClose:       tracker.payer,        // mandatory; pinned by relayer
})
```

**Race classes:**
- `RedemptionTrackerFlowMismatch` — caught by precondition 2.
- `RedemptionRequestMismatch` — caught by precondition 2.
- `RedemptionNotFulfilled` — caught by precondition 3; if reached
  on-chain anyway, demote to noop (race against OnRe closing the PDA
  is a benign race).

**Idempotency:** the tracker close is the dedup point — once closed,
re-attempt fails at the `redemption_tracker` Anchor account-load
because it's now a SystemAccount instead of `Account<RedemptionTracker>`.

**`AdvanceResult` on success:**
```text
{ kind: 'advanced', fromStatus: 'RedemptionPending',
  toStatus: 'WithdrawSwapped' }
```

---

### 3.4 `sendUsdcToUser` (file: `src/relayer/send-usdc-to-user.ts`)

**Pattern reference:** `lock-onyc.ts` (NTT outbound from a
relayer-PDA-owned ATA, with relayer_authority + session_authority
lamport top-ups, and OutboxItem keypair generation).

**Off-chain preconditions:**
1. **Outflight flow exists with status `Swapped`** (withdraw-leg
   meaning).
2. **`RedemptionTracker` is closed** (SystemAccount). If it's open,
   another flow is in `RedemptionPending` and the on-chain
   `redemption_tracker: SystemAccount` constraint will fail. Return
   `kind: 'noop'` with reason "tracker held by other flow=…
   (waiting)". This blocks `send_usdc_to_user` globally during any
   in-flight redemption — see §4.2 for the daemon-level ordering
   implications.
3. **FOGO peer registered on USDC NTT manager.** Same check
   `lock-onyc.ts:106–112` does for ONyc; use
   `findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, NTT_USDC_PROGRAM_ID)`.
4. **`registered_transceiver` PDA initialized on USDC NTT manager.**
   Same check `lock-onyc.ts:121–133` does for ONyc.
5. **Lamport top-ups for `relayer_authority` and `session_authority`.**
   Same shape as `lock-onyc.ts:137–173`. The session_authority for
   *this* call is derived using `NTT_USDC_PROGRAM_ID` + the transfer
   args hash for `(amount, FOGO_WORMHOLE_CHAIN_ID, fogo_sender,
   should_queue=false)`.

**SDK call:**
```text
client.sendUsdcToUser({
  payer:               keypair.publicKey,
  usdcMint:            cfg.usdcMint,
  nttInboxItem:        flow.nttInboxItem,
  rentDestination:     flow.payer,           // pinned by relayer
  outboxItem:          freshKeypair.publicKey,
  release:             { wormholeProgram, ..., outboxItemSigner },
})
.preInstructions(fundIxs)
.signers([outboxItem])
```

The `release` object is built by `deriveLockOnycReleaseAccounts`'s
twin for the USDC manager — same shape, instantiate `SolanaNtt` with
`manager: NTT_USDC_PROGRAM_ID` and call `getWormholeTransceiver()` →
`createReleaseWormholeOutboundIx(payer, outboxItem, false)`. Factor
this helper out of `lock-onyc.ts` if it's not already shared.

**Race classes:**
- `FlowStatusMismatch` — caught by precondition 1.
- `RedemptionTracker` Anchor type-mismatch ("expected SystemAccount,
  got initialized") — caught by precondition 2; if reached on-chain,
  demote to noop.
- NTT outbox rate-limit hit — retryable on next scan.

**Idempotency:** `outflight_flow` is closed (`close = rent_destination`)
on success. Re-attempt fails at the Flow PDA load because it's a
SystemAccount.

**`AdvanceResult` on success:**
```text
{ kind: 'advanced', fromStatus: 'WithdrawSwapped',
  toStatus: 'WithdrawClosed' }
```

The user's USDC.s ATA on FOGO will be credited once Wormhole
guardians sign + the standard NTT inbound relayer (NOT this cranker
— this is the symmetric "deposit-leg-on-FOGO" handler, which is
Wormhole's responsibility, not ours) submits the redeem on FOGO.
That part already works; nothing to build there.

---

### 3.5 The leg-disambiguation problem and `FLOW_STATUSES` extension

The on-chain `FlowStatus` enum has three variants
(`Claimed`, `Swapped`, `RedemptionPending`) shared between two legs.
Status alone cannot drive dispatch. Two viable approaches:

**Option A — synthetic leg-prefixed statuses in the cranker.** Extend
`FLOW_STATUSES` in `scan.ts` to:
```
['Pending', 'Claimed', 'Swapped', 'Locked', 'Closed',           // deposit
 'WithdrawPending', 'WithdrawClaimed', 'RedemptionPending',
 'WithdrawSwapped', 'WithdrawClosed']                            // withdraw
```
Map on-chain `(leg, status)` pairs to these synthetic strings during
enumeration:
- deposit + `Claimed` → `'Claimed'`
- withdraw + `Claimed` → `'WithdrawClaimed'`
- deposit + `Swapped` → `'Swapped'`
- withdraw + `Swapped` → `'WithdrawSwapped'`
- withdraw + `RedemptionPending` → `'RedemptionPending'` (no collision
  with deposit; deposit never reaches this state)

`pickAdvanceForStatus` then dispatches:
- `Pending` → `claimUsdc`
- `Claimed` → `swapUsdcToOnyc`
- `Swapped` → `lockOnyc`
- `WithdrawPending` → `unlockOnyc`
- `WithdrawClaimed` → `requestRedemptionOnyc`
- `RedemptionPending` → `claimRedemptionUsdc`
- `WithdrawSwapped` → `sendUsdcToUser`

**Pro:** dispatch table stays a flat switch; flow-state tracker keys
on a single string; the chain-leg loop in `scanAndAdvance` works
unchanged.
**Con:** introduces strings that don't appear in the on-chain enum;
mental load when reading logs.

**Option B — leg + status as a tuple, dispatcher takes both.**
Carry `leg: 'deposit' | 'withdraw'` on `ScannedFlow` (it's already
known at enumeration time — see `enumerate.ts:103`'s `leg` parameter)
and change `pickAdvanceForStatus` signature to
`pickAdvanceForStatus(leg, status, fns)`.

**Pro:** mirrors the on-chain truth more faithfully; no synthetic
strings.
**Con:** `FlowStateTracker.beginIfReady(flowKey)` takes a single
string today; would need either (leg, flow) keying or composite-key
encoding, with a second invasion site.

**Recommendation:** **Option A.** The synthetic strings are an
implementation detail of the cranker's FSM; the on-chain enum is
unchanged. The flat dispatch table is easier to extend further (a
future version with a curator-backed unlock might add
`'CuratorPending'`, etc.) and the rollup logs key cleanly on these
strings. Option B's purity isn't worth the second-site change.

---

## 4. Daemon plumbing changes

### 4.1 `enumerate.ts`: leg-aware Flow PDA fetch

Today (`enumerate.ts:151`):
```text
const flow = await ctx.client.fetchInflightFlow(resolved.nttInboxItem)
```

Change (pseudocode — not implementation):
```text
const flow = leg === 'withdraw'
  ? await ctx.client.fetchOutflightFlow(resolved.nttInboxItem)
  : await ctx.client.fetchInflightFlow(resolved.nttInboxItem)
```

And the synthesized status:
```text
status: flow
  ? mapLegStatusToSyntheticStatus(leg, describeStatus(flow.status))
  : (leg === 'withdraw' ? 'WithdrawPending' : 'Pending')
```

`mapLegStatusToSyntheticStatus` is a 6-line function implementing the
table in §3.5.

The `ScannedFlow.pubkey` field still carries `nttInboxItem` (the
seed input, not the Flow PDA itself); the Flow PDA is re-derived in
each handler via `findOutflightFlowPda(nttInboxItem)` — same as
deposit's pattern.

### 4.2 `scan.ts`: dispatch + chain-walk

- Extend `FLOW_STATUSES` per Option A in §3.5.
- Extend `AdvanceFns` to include the four new handlers.
- Extend `pickAdvanceForStatus` switch.
- The chain-walk loop (`while (nextDispatch)`) works unchanged for
  all transitions **except** `WithdrawClaimed → RedemptionPending →
  WithdrawSwapped`. The transition to `WithdrawSwapped` requires OnRe
  to fulfill off-chain — the in-tick walk *will* attempt
  `claimRedemptionUsdc` immediately after `requestRedemptionOnyc`
  succeeds, and that attempt will return `noop` because the off-chain
  precondition "redemption_request closed" is false (OnRe just
  received the request seconds ago). That's fine — `noop` breaks the
  loop cleanly and the next scan retries. No special-case code needed.

### 4.3 `RedemptionTracker` global serialization

This is the most subtle daemon-level concern. Within one scan tick,
`scan.ts` may consider multiple withdraw flows. Naive concurrent
dispatch produces this failure mode:
- Flow A is in `WithdrawClaimed`; cranker dispatches
  `requestRedemptionOnyc` → opens `RedemptionTracker(flow=A)`.
- Concurrently, Flow B is in `WithdrawSwapped`; cranker dispatches
  `sendUsdcToUser` → fails because tracker is open.
- Concurrently, Flow C is in `WithdrawClaimed`; cranker dispatches
  `requestRedemptionOnyc` → fails because tracker is open.

Result: A advances, B and C are noop'd this tick, retried next tick.
**This is fine for correctness.** The race classifier should learn
the "tracker held" failure as a benign, common defer (debug, not
warn).

For latency, an optional optimization: **dispatch withdraw flows
serially within a tick**, and prefer
`WithdrawSwapped → sendUsdcToUser` over
`WithdrawClaimed → requestRedemptionOnyc` so the tracker is released
before being re-acquired. This is a single sort + a flag on the
withdraw branch of the per-flow scheduling loop. Not required for
v1; flag for a follow-up if operator latency complaints surface.

The existing `FlowStateTracker.beginIfReady` already gates per-flow
re-entrancy; it does NOT gate cross-flow contention on a shared
resource. Don't try to model the tracker mutex client-side — the
on-chain `init` is the authoritative gate, and treating the
`AccountAlreadyInUse` as a benign defer is sufficient.

### 4.4 Metrics

Extend the Prometheus surface (`src/metrics.ts`) with:
- `txSent{instruction='unlock_onyc' | 'request_redemption_onyc' |
   'claim_redemption_usdc' | 'send_usdc_to_user', result=…}`
- `flowAdvance{leg='withdraw', from_status=…, to_status=…}` —
  `leg` label is already present.
- A new gauge `redemption_tracker_held` (0 or 1) sampled each scan
  iteration. Useful for alerting on stuck redemptions (e.g., open
  tracker for > 1 hour without `claim_redemption_usdc` advancing).
- A new counter `withdraw_handler_deferred{handler=…, reason=…}`
  for the tracker-contention noop case.

Add corresponding Prometheus rules in
`deploy/cranker/prometheus/rules.yml`:
- `RedemptionTrackerStuck`: `redemption_tracker_held == 1` for >
  30min — page operator (OnRe queue may be jammed).
- `WithdrawFlowsBacklogged`: `flow_skipped{reason='tracker_held'}`
  rate > 1/min for > 10min — operator should investigate.

### 4.5 Wormhole emitter config

`enumerate.ts` reads `opts.fogoOnycEmitterHex` and harvests if set.
`config.ts` must already be passing this (the conditional is in
place since 4344b44 era). Verify it's wired through from
`bin.ts` → daemon config → enumerator. If not, add the env var
`CRANKER_FOGO_ONYC_EMITTER_HEX` (or whatever the existing convention
is for `CRANKER_FOGO_USDC_EMITTER_HEX`).

---

## 5. CLI mirror (`packages/cli/src/commands/cranker.ts`)

The CLI exists for operator hand-cranking (incidents, the recovery
case that triggered this entire spec). Add four subcommands mirroring
the deposit-side shape, plus an `advance-withdraw` sweeper.

### 5.1 New subcommands

| Command                                          | Pre-status         | Post-status         | Notes                                                                                              |
|--------------------------------------------------|--------------------|---------------------|----------------------------------------------------------------------------------------------------|
| `cranker unlock-onyc --fogo-tx <SIG>`            | (no flow)          | `WithdrawClaimed`   | Mirrors `claim-usdc` shape. Args: `--vaa <HEX>` fallback, `--user-wallet` not needed (parsed from VTM). |
| `cranker request-redemption-onyc --fogo-tx <SIG>` | `WithdrawClaimed`  | `RedemptionPending` | Mirrors `swap-usdc-to-onyc`. Wraps the singleton-tracker contention as a clear error message.      |
| `cranker claim-redemption-usdc --fogo-tx <SIG>`  | `RedemptionPending`| `WithdrawSwapped`   | New verb. Pure on-chain state read + relayer ix. Print waiting-on-OnRe diagnostic if not ready.    |
| `cranker send-usdc-to-user --fogo-tx <SIG>`      | `WithdrawSwapped`  | (closes flow)       | Mirrors `lock-onyc` shape (NTT outbound with top-ups + outboxItem keypair).                        |
| `cranker advance-withdraw --fogo-tx <SIG>`       | any                | (best-effort chain) | Mirrors `cranker advance` for the withdraw chain.                                                  |

`status` already prints the right thing for withdraws (it shows
`outflight` Flow if present); the "Next step" hint should be extended
to suggest the new withdraw verbs based on observed status. Replace
the placeholder `(withdraw leg, once implemented)` line.

### 5.2 `advance-withdraw` chaining strategy

Mirror `cranker advance`'s "do everything in one shot" pattern but
respect the off-chain async boundary at `RedemptionPending`:

- TX 1: `unlock_onyc` (alone — initializes outflight_flow PDA which
  step 2 reads)
- TX 2: `request_redemption_onyc` (alone — opens
  `RedemptionTracker`)
- WAIT: poll OnRe `redemption_request` PDA until closed (with
  `--wait-timeout` flag, default e.g. 10 minutes; document that
  fulfillment time depends on OnRe queue state)
- TX 3: `claim_redemption_usdc` + `send_usdc_to_user` bundled in one
  tx — both read the closed-tracker state, and the post-status
  transition is atomic. Verify against compute budget; if too large,
  split.

The deposit-side `advance` proves combining multiple steps in one tx
is safe when they touch the same state in a forward-only direction;
the same logic applies here for steps 3+4.

### 5.3 Account-list builders

The CLI needs to construct `remaining_accounts` for the OnRe CPIs
(step 2 + step 3) and the NTT redeem/release (step 1) and NTT lock
(step 4). All four account lists already exist in the SDK:
- NTT redeem + release_inbound_unlock — same builders `claim-usdc.ts`
  uses
- OnRe `create_redemption_request` — same shape as the unused
  `cancel_redemption_onyc` builder (or write it; check
  `packages/sdk/src/builders/onre.ts`)
- NTT lock outbound — same builders `lock-onyc.ts` uses

If any are missing, that's an SDK gap to fill before the daemon
handlers can be written, since the daemon uses them too.

---

## 6. Test surface

### 6.1 Existing fixtures

`tests/utils/withdraw-scaffolding.ts` is the rig. It already
sets up:
- ONyc NTT manager binary (sha256-pinned via `pinBinaryFixtures()`)
- OnRe state/offer/authorities (JSON dumps from mainnet)
- A user with ONyc balance ready to burn
- Ability to drive a synthetic VAA representing an inbound transfer

This file existing — when the production daemon doesn't drive
withdrows — is itself evidence that the chain was always intended
to be production-driven. The test rig is pre-built; the production
driver was deferred.

### 6.2 Tests to add (alongside each handler)

For each of the four handlers, an integration test in `tests/`:

- `tests/cranker-unlock-onyc.test.ts`
- `tests/cranker-request-redemption-onyc.test.ts`
- `tests/cranker-claim-redemption-usdc.test.ts`
- `tests/cranker-send-usdc-to-user.test.ts`

Each follows the deposit-leg test pattern (e.g.,
`tests/cranker-claim-usdc.test.ts` if it exists, else mirror the
relayer-test pattern in `tests/relayer.test.ts`):
- Set up the rig from `withdraw-scaffolding.ts`.
- Build the precondition state on-chain.
- Invoke the cranker handler directly (not via daemon — test the
  unit).
- Assert post-status, asset movements, event emission.

End-to-end test in `tests/cranker-withdraw-e2e.test.ts`:
- Start from VAA + closed state.
- Run handlers in sequence.
- Assert flow advances WithdrawPending → … → flow closed, USDC
  on FOGO crediting (or its on-Solana proxy if the test rig doesn't
  span chains).

### 6.3 Daemon-level tests

Extend `packages/cranker/tests/`:
- `daemon-withdraw.test.ts`: simulate the enumerator returning a
  withdraw VAA, assert dispatch goes to `unlockOnyc`, assert the
  in-tick chain walks through to `RedemptionPending` and breaks.
- Extend `scan.test.ts` with the leg-disambiguating dispatch table
  cases per §3.5.
- `tracker-contention.test.ts`: simulate two withdraw flows in the
  same tick, both in `WithdrawClaimed`. Assert one advances, the
  other no-ops with the tracker-held reason. Assert the
  tracker-held noop is classified as benign (debug, not warn).

### 6.4 Sha256 binary pin

The OnRe binary fixture sha256 in `withdraw-scaffolding.ts` may need
re-pinning if OnRe's deployment has rolled since the fixture was
captured. Verify before declaring tests reliable. If a pin needs
refreshing, follow the lockstep refresh pattern documented in
CLAUDE.md (refresh binary + mirrored types in `constants.rs` /
`onre.rs` together).

---

## 7. Execution order (for the implementer)

Suggested PR sequence — each lands independently, the chain isn't
broken between PRs:

1. **PR 1 — daemon: leg-aware enumerator + handler skeleton.**
   - Refactor `enumerate.ts` to leg-aware Flow lookup.
   - Extend `FLOW_STATUSES` and `pickAdvanceForStatus`.
   - Add four no-op handler stubs that return `kind: 'noop',
     reason: 'unimplemented'`.
   - Existing daemon behavior is unchanged because the new dispatch
     branches all return noop. Withdraws now correctly show as
     `WithdrawPending` in logs instead of permanently `Pending`.

2. **PR 2 — handler 1: `unlockOnyc`.**
   - Implement + tests + race classes.
   - At this point the daemon will start advancing withdraws to
     `WithdrawClaimed` and stop (handler 2 still noop).

3. **PR 3 — handler 2: `requestRedemptionOnyc`.**
   - Add the singleton-tracker race class.
   - Daemon advances to `RedemptionPending` and waits.

4. **PR 4 — handler 3: `claimRedemptionUsdc`.**
   - Daemon advances to `WithdrawSwapped` once OnRe fulfills.

5. **PR 5 — handler 4: `sendUsdcToUser`.**
   - Daemon closes the flow. Withdraw chain end-to-end.

6. **PR 6 — CLI mirror.**
   - Subcommands + `advance-withdraw`. Now operators can hand-crank
     during incidents.

7. **PR 7 — metrics + Prometheus rules.**
   - Operational observability.

8. **PR 8 — backfill: drive the existing stranded flow.**
   - Operator runs `cranker advance-withdraw --fogo-tx
     6DNyLuEzoyf7brr3sKNtsEHMVeuivNs2JVFRRRJ6pQZUQBE2wgF8EsjdoBpfzbL7T1FwVGuHLJRtyT9s3qZb6iz`
     against the recovery tx for outbox item
     `AZ65VwGWDAvg1xDLdb2ynAbyVqVFSnCxFhCygG5VzZxr` to clear the
     known stuck withdraw documented in commits `4344b44` /
     `50bd03d`.

Estimated total: 600-900 LOC of TypeScript across the daemon and
CLI, plus ~200 LOC of tests per handler (~800 LOC of tests). No
on-chain code touched.

---

## 8. Risks and known unknowns

- **OnRe queue dynamics are off-chain to OnRe.** We don't know the
  fulfillment SLA. The daemon's `RedemptionPending → Swapped`
  transition could sit for minutes, hours, or days. If long, the
  singleton tracker means OTHER withdraws are also blocked. Mitigation:
  the `cancel_redemption_onyc` ix (already on-chain at
  `programs/relayer/src/instructions/cancel_redemption_onyc.rs`)
  exists for exactly this case — authority-gated, not permissionless.
  This means the daemon CANNOT auto-cancel a stuck redemption; only
  the relayer authority can. Document this clearly in
  `deploy/cranker/` runbooks.

- **`session_authority` derivation for `sendUsdcToUser`.** The hash
  is over `(amount, FOGO_WORMHOLE_CHAIN_ID, fogo_sender,
  should_queue=false)`. Any drift in the on-chain hashing scheme
  silently produces the wrong PDA → CPI fails with `OwnerMismatch`
  on TransferChecked. Cover with a determinism test that mirrors
  what `nttTransferArgsHash` produces vs what
  `derive_session_authority` produces in Rust.

- **Compute budget on `unlockOnyc`.** Three Anchor CPIs in one tx
  (NTT redeem, NTT release_inbound_unlock, relayer unlock_onyc).
  May or may not fit in 200k. First-PR sim is the source of truth.

- **`tests/utils/withdraw-scaffolding.ts` binary pin freshness.**
  The current pinned OnRe binary may not match production. Verify
  before declaring the implementation correct against mainnet OnRe
  behavior.

- **Daemon polling cost.** The enumerator already pages both legs;
  no additional Wormholescan load. The cost is per-flow on-chain
  reads (Outflight Flow PDA per withdraw VAA). For typical volumes
  this is negligible, but worth noting if withdraws ever spike.

- **`describeStatus(flow.status)` in the SDK** must be checked: it
  may return enum tag strings that don't match what
  `mapLegStatusToSyntheticStatus` expects. Verify exact return
  values before wiring.

---

## 9. Out of scope for this spec

- Auto-cancellation of stuck redemptions (requires authority
  signing; daemon doesn't custody an authority key).
- Wormhole inbound on FOGO (USDC.s redeem on FOGO is Wormhole's
  standard relayer's job; not built or operated here).
- A self-driving "watch FOGO mempool for new burns and pre-warm
  pipeline" — current pull-from-Wormholescan model is sufficient.
- Per-user UX surfacing of withdraw progress in the webapp — that's
  the bridge-history work tracked separately in
  `2026-05-09-bridge-history-design.md`.

---

## 10. Acceptance criteria

The work is done when:

1. A fresh user-initiated FOGO ONyc withdraw lands USDC in the
   user's Solana ATA without any operator action.
2. Two concurrent withdraws serialize correctly on the singleton
   tracker without surfacing alerts.
3. The CLI can hand-crank any individual step or sweep the whole
   chain via `advance-withdraw`.
4. Prometheus surfaces a stuck redemption (open tracker > 30 min)
   as a paging alert.
5. The previously-stranded flow at outbox item
   `AZ65VwGWDAvg1xDLdb2ynAbyVqVFSnCxFhCygG5VzZxr` clears and the
   user receives USDC.
6. All four handler unit tests + the e2e test pass under
   `pnpm test`.
7. No regression on deposit-leg metrics or behavior.
