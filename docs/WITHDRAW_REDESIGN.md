# Withdraw Chain Redesign — Implementation Spec

**Status (Apr 2026)**: design verified against `onre-finance/onre-sol`
and live mainnet state. Ready for human design review before code lands.

This document is the bridge between
`docs/PRE_DEPLOY_CHECKLIST.md` §4 (which says "this is broken; here are
the resolution paths") and the actual relayer code that implements
**path (a)**: split the relayer's withdraw chain into a
`request_redemption_onyc` + `claim_redemption_usdc` pair, where the
OnRe-side fulfillment happens between them and is signed by OnRe's
`redemption_admin`.

Path (b) — coordinate with OnRe to ship a permissionless atomic
counterpart to `take_offer_permissionless` for `RedemptionOffer` —
would be cleaner trust-model-wise but is an external-protocol change
not under our control. This spec assumes (a). If (b) becomes available
later, the changes here can be reverted in favor of a one-instruction
swap.

---

## 1. OnRe protocol facts (verified)

### 1.1 Account types and PDAs

| Account              | Seeds (under OnRe program)                                       | Mainnet (USDC/ONyc pair)                       |
| -------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `Offer` (deposit)    | `[b"offer", USDC_mint, ONyc_mint]`                               | `E88zkA9Pxb1i8EfSHrEW5ZUe6hiQbo8DHWQ3WhDFw7p6` ✅ |
| `RedemptionOffer`    | `[b"redemption_offer", ONyc_mint, USDC_mint]`                    | `3pLK2vXD2uy9PPZuYZNZWkkP9CTEuGrhS2uYFRUWZrSu` ✅ |
| `RedemptionRequest`  | `[b"redemption_request", redemption_offer, request_counter_le]`  | per-request, ephemeral                         |
| Redemption vault PDA | `[b"redemption_offer_vault_authority"]`                          | one global PDA for all redemption vaults       |

OnRe program ID: `onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe` (already
in `programs/relayer/src/constants.rs::ONRE_PROGRAM_ID`).

USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`.
ONyc mint: `5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5`.

### 1.2 Instruction discriminators (Anchor sighash, sha256("global:"+name)[..8])

| Instruction                                          | Discriminator (u8 array)                          |
| ---------------------------------------------------- | ------------------------------------------------- |
| `take_offer_permissionless` (existing, deposit only) | `[37, 190, 224, 77, 197, 39, 203, 230]`           |
| `create_redemption_request` (NEW)                    | `[201, 53, 181, 254, 115, 137, 70, 151]`          |
| `fulfill_redemption_request` (NEW, OnRe-side only)   | `[140, 124, 139, 242, 179, 153, 208, 66]`         |

### 1.3 `create_redemption_request` accounts (12 total, in order)

From `onre-finance/onre-sol:programs/onreapp/src/instructions/redemption/create_redemption_request.rs`:

```
0  state                       Read-only PDA, [b"state"]
1  redemption_offer            Mutable, [b"redemption_offer", ONyc, USDC]
2  redemption_request          init, payer=redeemer, PDA seeds:
                               [b"redemption_request", redemption_offer, counter_le]
3  redeemer                    Signer + mut + payer
4  redemption_vault_authority  Read-only PDA, [b"redemption_offer_vault_authority"]
5  token_in_mint               Read-only, must equal redemption_offer.token_in_mint (ONyc)
6  redeemer_token_account      Mutable, ATA(token_in_mint, redeemer)
7  vault_token_account         Mutable, ATA(token_in_mint, redemption_vault_authority)
8  token_program               SPL Token program (token-2022 supported via Interface)
9  associated_token_program    Standard ATA program
10 system_program              System program
```

Args: `amount: u64`.

**Permissionless caller**: line 134 of OnRe source — "Anyone can create a
redemption request (no admin signature required)". Critical for our
design: the relayer's authority PDA can be the redeemer.

### 1.4 What fulfillment does (off-chain to us, but observable on-chain)

When OnRe's `redemption_admin` calls `fulfill_redemption_request` for our
request:
1. ONyc is taken from the redemption vault (burned if OnRe has mint
   authority, otherwise transferred to boss).
2. USDC is delivered to `user_token_out_account` — **the ATA owned by
   the address stored in `redemption_request.redeemer`**.
3. The `redemption_request` PDA is closed (`close = redemption_admin`).

**Observable signal to the relayer**: the `RedemptionRequest` PDA's
account no longer exists (lamports = 0, owner = system program, data
length = 0). The relayer's USDC ATA balance has increased by
`token_out_amount` (computed by OnRe from the offer's price vector).

---

## 2. Relayer-side design

> **Backward-compat constraint** (added after first §5.2 attempt was
> reverted in commit `35bc49f`): the program ID
> `Re1ayRHhmeqByGjgT5uLFExZCvQ8sv6LK74xowK8pJH` is shared across
> mainnet/devnet/localnet. Any change to `Flow`'s borsh layout would
> brick already-allocated `Flow` PDAs from prior deploys (devnet soak,
> testing, etc.). Therefore: `Flow` must stay byte-stable, and any new
> withdraw-chain state has to live in a sidecar PDA.

### 2.1 New `FlowStatus` variant — appended to preserve borsh tags

```rust
pub enum FlowStatus {
    Claimed,            // tag 0, unchanged
    Swapped,            // tag 1, unchanged
    RedemptionPending,  // tag 2, NEW — appended (NOT inserted) to keep
                        // existing PDAs deserialisable
}
```

Borsh encodes enum variants as a 1-byte positional tag. Inserting
`RedemptionPending` *between* `Claimed` and `Swapped` would shift
`Swapped` from tag 1 to tag 2 and break every existing Flow PDA on
read. `derive(InitSpace)` reports `1 + max(variant_init_space) = 1`
regardless of variant count (≤256 payload-less arms), so `Flow`'s
total size is unchanged.

Deposit chain still uses `Claimed → Swapped` (no behavior change).
Withdraw chain becomes `Claimed → RedemptionPending → Swapped`.

### 2.2 Sidecar `RedemptionTracker` PDA (replaces the original "new Flow fields" plan)

Rather than extending `Flow` (incompatible with live PDAs), the
withdraw-chain state lives in a sidecar account that exists only while
a flow is `RedemptionPending`:

```rust
#[account]
#[derive(InitSpace)]
pub struct RedemptionTracker {
    /// Outbound `Flow` PDA this tracker is paired with — 1:1 binding
    /// enforced by both the seed derivation AND a stored field for
    /// belt-and-braces.
    pub flow: Pubkey,

    /// OnRe `RedemptionRequest` PDA. The relayer polls for its closure
    /// as the fulfillment signal (see §2.3.2).
    pub redemption_request: Pubkey,

    /// Relayer's USDC ATA balance snapshotted *before*
    /// `create_redemption_request` fires. `claim_redemption_usdc`
    /// computes the post-fulfillment delta against this.
    pub usdc_ata_pre_balance: u64,

    /// ONyc amount net of fee that was sent to OnRe — for audit trail
    /// and for the §2.4 race-safety check (`expected_usdc` strategy).
    pub onyc_amount_in: u64,

    /// Pays for init, receives rent on close (= cranker who called
    /// `request_redemption_onyc`).
    pub payer: Pubkey,

    pub bump: u8,
}
```

**Seeds**: `[REDEMPTION_TRACKER_SEED, flow_pda]` — exactly one tracker
per `Flow`. The same cranker-permissionless model as the rest of the
program (anyone can pay for init; recipient is bound by Flow's
fogo_sender, not by the cranker).

**Lifecycle**:
- Created in `request_redemption_onyc` alongside the
  `flow.status = RedemptionPending` write. Both writes happen in a
  single tx; if the OnRe CPI fails, both revert.
- Closed in `claim_redemption_usdc` (rent → `tracker.payer`) alongside
  the `flow.status = Swapped` write.

**Why a sidecar is strictly better than mutating `Flow`**:
1. Zero compatibility risk for any existing Flow PDA.
2. Deposit-chain Flow PDAs cost zero extra bytes — the tracker only
   exists for withdraw flows that actually hit OnRe redemption.
3. Reverting path (a) in favor of path (b) is one
   `delete RedemptionTracker` away — no Flow migration needed.
4. The `RedemptionTracker::INIT_SPACE` audit surface is bounded to a
   single account and trivially countable.

### 2.3 Replace `swap_onyc_to_usdc` with two instructions

#### 2.3.1 `request_redemption_onyc` (permissionless)

Replaces the front-half of the old swap. Pre: `flow.status == Claimed`.
Post: `flow.status == RedemptionPending`, sidecar
`RedemptionTracker` PDA initialised with the OnRe `RedemptionRequest`
address and the USDC ATA pre-balance snapshot.

Steps:
1. Take withdrawal-leg fee from `flow.amount` ONyc, route to `fee_vault`
   (same logic as current `swap_onyc_to_usdc:30-47`).
2. Snapshot `usdc_ata.amount` into `tracker.usdc_ata_pre_balance`.
3. Read `redemption_offer.request_counter` *before* the CPI fires;
   derive the `RedemptionRequest` PDA address; store in
   `tracker.redemption_request`.
4. CPI `create_redemption_request(amount=net)` on OnRe. The relayer's
   `relayer_authority` PDA is the `redeemer` (signs via PDA seeds).
5. Set `tracker.flow = flow.key()`, `tracker.onyc_amount_in = net`,
   `tracker.payer = ctx.accounts.payer.key()`, `tracker.bump`.
6. Set `flow.amount = net` (will be replaced by USDC delta in §2.3.2);
   set `flow.status = RedemptionPending`.

Required `remaining_accounts`: full OnRe `create_redemption_request`
account list from §1.3, with the `redeemer` slot positionally bound
to `relayer_authority`.

#### 2.3.2 `claim_redemption_usdc` (permissionless)

Replaces the back-half. Pre: `flow.status == RedemptionPending`,
sidecar `RedemptionTracker` exists for this flow. Post:
`flow.status == Swapped`, `flow.amount = USDC delta`, tracker closed
to `tracker.payer`.

Steps:
1. Anchor `has_one`-style check: `tracker.flow == flow.key()`.
2. Take `redemption_request_account: AccountInfo` from accounts; require
   `redemption_request_account.key() == tracker.redemption_request`.
3. Verify the PDA was closed:
   ```rust
   require!(
       redemption_request_account.lamports() == 0
           && redemption_request_account.data_is_empty()
           && redemption_request_account.owner == &system_program::ID,
       RelayerError::RedemptionNotFulfilled
   );
   ```
4. Reload `usdc_ata`. Compute
   `delta = usdc_ata.amount - tracker.usdc_ata_pre_balance`.
   Require `delta > 0`.
5. `flow.amount = delta`; `flow.status = Swapped`.
6. Close `tracker` (Anchor `close = payer` constraint).

After this, the existing `send_usdc_to_user` instruction works
unchanged — it only reads `flow.fogo_sender` and `flow.amount`.

### 2.4 Concurrency safety

Multiple withdraw flows can be `RedemptionPending` simultaneously —
each has a distinct `RedemptionRequest` PDA (OnRe increments
`request_counter` per request) and a distinct `RedemptionTracker`
(seeded by Flow). Step 2.3.2's USDC delta calculation is the only
race-prone part: if two flows race on `claim_redemption_usdc` while the
USDC ATA receives funds for both, both might see the combined delta.

**Mitigation options** (open question §6):
- **Mutex PDA**: serialise all `claim_redemption_usdc` calls. Simple
  but bottlenecks throughput.
- **`expected_usdc` snapshot in tracker**: store
  `tracker.expected_usdc = price * onyc_amount_in` computed from the
  `RedemptionOffer`'s current price vector before the CPI. Step 2.3.2
  verifies `delta >= tracker.expected_usdc`. Precise, but requires us
  to duplicate OnRe's pricing logic on-chain.

### 2.5 New `RelayerError` variants

```rust
RedemptionNotFulfilled,         // RedemptionRequest PDA still exists
RedemptionRequestMismatch,      // claim PDA != tracker.redemption_request
RedemptionTrackerFlowMismatch,  // tracker.flow != flow.key()
MissingRedemptionState,         // tracker missing when status == RedemptionPending
```

### 2.6 New constants

```rust
// constants.rs additions
pub const ONRE_CREATE_REDEMPTION_REQUEST_IX: [u8; 8] =
    [201, 53, 181, 254, 115, 137, 70, 151];

pub const ONRE_REDEMPTION_OFFER_SEED: &[u8] = b"redemption_offer";
pub const ONRE_REDEMPTION_REQUEST_SEED: &[u8] = b"redemption_request";
pub const ONRE_REDEMPTION_OFFER_VAULT_AUTHORITY_SEED: &[u8] =
    b"redemption_offer_vault_authority";

/// Relayer-side sidecar PDA seed: `[seed, flow_pda]`. One tracker per
/// outbound Flow, exists only while `flow.status == RedemptionPending`.
pub const REDEMPTION_TRACKER_SEED: &[u8] = b"redemption_tracker";
```

(Note: the deposit-side `take_offer_permissionless` discriminator and
the OnRe program ID stay as they are — they're still used by
`swap_usdc_to_onyc`.)

---

## 3. Trust model delta

### 3.1 Before this redesign (and false today)

`SECURITY_MODEL.md` headline: "every flow-driving instruction is
permissionless, no operator key the system depends on."

### 3.2 After this redesign

| Property                                  | Deposit chain | Withdraw chain (post-redesign) |
| ----------------------------------------- | ------------- | ------------------------------ |
| Permissionless caller                     | ✅ Yes        | ✅ Yes for relayer ix          |
| Atomic in one tx                          | ✅ Yes        | ❌ No — two relayer ix + OnRe admin tx between |
| No off-chain operator key needed          | ✅ Yes        | ❌ No — OnRe `redemption_admin` must fulfill |
| Liveness depends on third party           | ❌ No         | ✅ Yes — OnRe fulfillment SLA  |
| Fund-loss risk if OnRe admin disappears   | ❌ No         | Soft — funds stuck in OnRe vault until admin returns; not lost, but unrecoverable until then |

### 3.3 Concrete updates this redesign forces in `SECURITY_MODEL.md`

- §1 key inventory: add row for "OnRe redemption_admin" with capability
  "controls fulfillment of withdraw-chain `RedemptionRequest`s; cannot
  redirect funds (recipient is bound to the relayer authority PDA at
  request creation), but can stall liveness indefinitely".
- §3 OnRe-program trust row: replace the "asymmetric callout" added
  during the doc-correction sprint with a real two-bullet split (deposit
  via `take_offer_permissionless`; withdraw via redemption flow with
  named admin dependency).
- §6 stuck-flow runbook: add `RedemptionPending` row with diagnosis
  steps (check `RedemptionRequest` PDA on-chain; ping OnRe ops if
  fulfillment hasn't happened within SLA).
- Top-of-file ⚠️ banner can be removed (was "verified-false until
  redesigned"; redesigned now).

### 3.4 Concrete updates this redesign forces in `PRE_DEPLOY_CHECKLIST.md`

- §4 callout: replace "verified architectural mismatch" warning with
  "✅ Resolved via withdraw-chain redesign; see commit log and §3
  audit list below".
- §3 audit list: ADD audit items for the new instructions
  (`request_redemption_onyc`: OnRe redeemer-binding correctness;
  `claim_redemption_usdc`: PDA-closed verification correctness; race
  safety per §2.4).
- §7 devnet soak: re-enable the withdrawal-cycle requirement, but add
  a sub-bullet "with OnRe `redemption_admin` participation —
  coordinate fulfillment cadence with OnRe ops".
- §8 cranking caveat: confirm path (a) was taken; document the new
  soft dependency on `redemption_admin` and how the cranker handles
  long fulfillment latency (re-crank `claim_redemption_usdc` is safe;
  no on-chain timeout exists; user funds remain in OnRe's
  redemption-vault custody until fulfillment).

---

## 4. Testing strategy

### 4.1 Unit tests (Rust)

- Discriminator math: re-verify `ONRE_CREATE_REDEMPTION_REQUEST_IX`
  matches `sha256("global:create_redemption_request")[..8]` at compile
  time via a `const fn`-style assertion or build-time test (current
  `ONRE_TAKE_OFFER_IX` has no such guard — add one for both during
  this work).
- New `Flow` field serialization round-trip with both `None` and
  `Some` variants.
- `claim_redemption_usdc` PDA-closed check unit (mock AccountInfo with
  zero lamports vs nonzero).

### 4.2 LiteSVM e2e (TypeScript, `tests/withdraw-flow-e2e.test.ts`)

The current placeholder becomes a real test. Strategy:

1. Capture the live `RedemptionOffer` fixture from mainnet
   (`3pLK2vXD…`) — same `solana account --output json` pattern as
   `ONRE_OFFER_FIXTURE`.
2. Capture the live OnRe `State` PDA fixture; **patch** the
   `redemption_admin` field at the known offset to a synthetic test
   keypair we control. This is the same fixture-patching pattern used
   for `loadAndPatchOnreOffer` in deposit tests.
3. Test flow:
   - `unlock_onyc` (existing) → Flow at `Claimed`.
   - `request_redemption_onyc` (NEW) → Flow at `RedemptionPending`,
     RedemptionRequest PDA created, ONyc moved to OnRe vault.
   - **Synthetic admin tx**: build and send a real
     `fulfill_redemption_request` ix signed by our patched-in test
     `redemption_admin`. USDC arrives in the relayer's USDC ATA;
     RedemptionRequest PDA is closed.
   - `claim_redemption_usdc` (NEW) → Flow at `Swapped`,
     `flow.amount = USDC delta`.
   - `send_usdc_to_user` (existing) → USDC bridged out, Flow PDA
     closed, rent returned.

### 4.3 Negative tests

- `claim_redemption_usdc` called before fulfillment →
  `RedemptionNotFulfilled`.
- `claim_redemption_usdc` with wrong PDA in slot →
  `RedemptionRequestMismatch`.
- `request_redemption_onyc` called twice on same flow →
  `FlowStatusMismatch` (status would already be `RedemptionPending`).
- Race: two flows in `RedemptionPending`, both fulfilled, both claimed
  in different orders — verify the §2.4 mitigation.

---

## 5. Implementation sequencing (proposed)

| Step | Scope                                                                      | LOC est. | Reviewable in isolation? |
| ---- | -------------------------------------------------------------------------- | -------- | ------------------------ |
| 5.1  | This spec doc + design review by user                                      | -        | YES                      |
| 5.2  | `state.rs` Flow + FlowStatus changes; `error.rs` new variants; `constants.rs` additions; cargo unit tests | ~150 | YES |
| 5.3  | `instructions/request_redemption_onyc.rs` (new); modify `lib.rs` dispatch  | ~200     | partially                |
| 5.4  | `instructions/claim_redemption_usdc.rs` (new); modify `lib.rs` dispatch    | ~150     | partially                |
| 5.5  | Delete `instructions/swap_onyc_to_usdc.rs`; remove from `lib.rs`           | ~20      | YES                      |
| 5.6  | Codama client regen (`pnpm scripts/generate-clients.mts`); SDK helper for `RedemptionRequest` PDA derivation | ~100 | YES |
| 5.7  | Capture `REDEMPTION_OFFER_FIXTURE`; patch `loadAndPatchOnreState` for `redemption_admin` | ~80 | YES |
| 5.8  | Rewrite `tests/withdraw-flow-e2e.test.ts` from placeholder to real chained e2e | ~400 | YES |
| 5.9  | Rewrite affected tests in `tests/relayer.test.ts` (every test referencing `swap_onyc_to_usdc`) | ~200 | partially |
| 5.10 | Doc reconciliation pass: SECURITY_MODEL, fogo-onre, README, PRE_DEPLOY_CHECKLIST | ~150 | YES |
| 5.11 | Re-engage external audit (the redesign introduces new attack surface; previous audit findings on `swap_onyc_to_usdc` are now moot) | - | YES |

Each step is a separate commit. Total estimated diff: ~1450 LOC.

---

## 6. Open questions for human decision (BEFORE step 5.2)

These are genuinely judgment calls, not implementation details:

1. **Confirm path (a)**. Is it OK to introduce a soft trust dependency
   on OnRe's `redemption_admin`, or do we want to hold the line on
   "fully permissionless" and instead lobby OnRe for path (b)?
2. **Race safety in §2.4**. Mutex PDA (simple but adds a serialisation
   bottleneck) vs `expected_usdc` snapshot (precise but requires
   computing the OnRe price ourselves on-chain — duplicates OnRe
   logic and is the historical source of cross-protocol bugs)?
3. **Rent for `RedemptionRequest` PDA**. The OnRe instruction makes the
   `redeemer` (= relayer authority PDA) the payer. Where does that
   rent come from? Two options:
   - Fund the relayer authority PDA with extra SOL up-front (operator
     pre-funds; rent comes back to relayer authority on close, but the
     close goes to OnRe `redemption_admin`, not to us — so we lose
     the rent each time).
   - Have the cranker top up the relayer authority on each
     `request_redemption_onyc` call. Either way the rent is a per-flow
     cost of ~0.002 SOL (typical PDA size). Decide whether to
     surface this in the SDK.
4. **Stuck-flow timeout**. Currently no on-chain timeout exists for
   any flow. With `RedemptionPending` we now depend on OnRe ops being
   alive. Do we want a `cancel_redemption` escape hatch? OnRe has
   `cancel_redemption_request` (callable by `redeemer`, i.e. the
   relayer authority — so we *could* implement a relayer-side
   permissionless cancel that returns ONyc to the relayer's ONyc ATA
   and the user can be re-bridged via a new flow). Or do we accept
   the dependency and document the SLO?
5. **Re-audit scope**. The redesign invalidates audit findings on
   `swap_onyc_to_usdc` and adds new attack surface. Is the existing
   audit firm available to scope a delta review, or do we need a
   fresh engagement?

---

## 7. What this spec is NOT

- Not a green light to start coding. Steps 5.2-5.10 should not begin
  until the §6 questions are resolved.
- Not a security analysis. The audit (item 5.11) is non-negotiable for
  mainnet.
- Not a guarantee that path (a) is the right answer. If OnRe ships a
  permissionless `take_redemption_offer_permissionless` in the next
  month, this entire spec gets thrown out in favor of a much smaller
  diff.

---

## 8. Appendix: verification commands

To re-verify any fact in this spec at any time:

```bash
# OnRe source clone (read-only reference)
git clone --depth 1 https://github.com/onre-finance/onre-sol.git /tmp/onre-sol

# Discriminator re-derivation
node -e 'const c=require("crypto"); console.log(Array.from(c.createHash("sha256").update("global:create_redemption_request").digest().slice(0,8)).join(", "))'

# Mainnet PDA existence
solana account 3pLK2vXD2uy9PPZuYZNZWkkP9CTEuGrhS2uYFRUWZrSu --url https://api.mainnet-beta.solana.com --output json

# RedemptionRequest PDA derivation (per-request, requires counter)
node -e '
const { PublicKey } = require("@solana/web3.js");
const ONRE = new PublicKey("onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe");
const offer = new PublicKey("3pLK2vXD2uy9PPZuYZNZWkkP9CTEuGrhS2uYFRUWZrSu");
const counter = 0n; // read from on-chain RedemptionOffer.request_counter
const counterLe = Buffer.alloc(8); counterLe.writeBigUInt64LE(counter);
const [pda] = PublicKey.findProgramAddressSync(
  [Buffer.from("redemption_request"), offer.toBuffer(), counterLe],
  ONRE,
);
console.log(pda.toBase58());
'
```
