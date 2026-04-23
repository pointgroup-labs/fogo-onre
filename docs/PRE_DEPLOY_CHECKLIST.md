# Pre-Deploy Checklist

This is the **mandatory** human-action checklist before deploying the relayer
program to mainnet. Every item here is something CI **cannot** verify on its
own — they require a deployer decision, a manual key handling step, or
real-network verification.

If you cannot truthfully tick a box, **do not deploy**.

---

## 1. Build & verify the binary

- [ ] Run `anchor build --verifiable` and confirm the resulting `.so` hash
      matches what gets uploaded to mainnet. The verifiable build pins the
      Rust toolchain inside a Docker container; this guards against the
      deployer's local Rust version producing a different binary than CI.
      *(Skipped during the Apr 2026 test-tightening sprint — must be done
      before deploy.)*
- [ ] Compare the program ID embedded in the binary (`anchor keys list`)
      to the canonical `onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp` in
      `Anchor.toml` and `programs/relayer/src/lib.rs`. They MUST match.
- [ ] Run `cargo test -p fogo-onre-relayer --lib` and confirm all unit tests
      pass.
- [ ] **Manually diff `programs/relayer/src/constants.rs`** in the deploy
      commit against the previous release. There is no automated CI
      alarm on changes to the CPI program IDs or instruction tags — a
      malicious or accidental swap would compile and ship silently.
      Verify every `pub const Pubkey` against the canonical mainnet
      source linked in its doc comment.

## 2. Upgrade authority

The relayer program is the system's trust anchor. Whoever holds the upgrade
authority can ship a new `.so` that bypasses every safety property in this
codebase (CPI allowlist, flow-status guards, fee math).

Choose ONE before deploy:

- [ ] **Immutable**: set upgrade authority to `None`
      (`solana program set-upgrade-authority --final ...`).
      No future patches possible — bugs require redeploying under a new
      program ID and migrating state. Highest assurance.
- [ ] **Multisig**: transfer upgrade authority to a Squads (or equivalent)
      multisig with ≥3-of-5 hardware-key signers and a public threshold.
      Document the signer roster in this file before deploy.
- [ ] **NEVER** leave upgrade authority on a single hot/warm key.

Selected option: ___________________________
Multisig address (if applicable): ___________________________
Signer roster (if applicable): ___________________________

### 2b. Config authority

The `config authority` (set at `initialize`, rotatable only via `configure`)
has **near-total blast radius on operating balances**: it can `sweep`
arbitrary amounts of USDC and ONyc out of the relayer-owned ATAs, set
fees to 100%, and redirect `fee_vault` to an attacker-controlled
account. See `SECURITY_MODEL.md` §4.2.5 for the full attack surface.

Treat this key with the **same handling as the upgrade authority**:

- [ ] **Multisig**: transfer config authority to a Squads (or equivalent)
      multisig with ≥3-of-5 hardware-key signers. The natural choice is
      the **same multisig** as the upgrade authority — there is no
      operational reason to separate them, and reusing it avoids the
      "either one alone is total" footgun.
- [ ] **NEVER** leave config authority on a single hot/warm key, even
      "temporarily" during ramp-up.
- [ ] Confirm the rotation procedure is understood by all signers:
      two-step propose/accept. Step 1: current authority calls
      `configure(new_authority=Some(pk))` — writes `pending_authority`,
      does NOT change `authority`. Step 2: the proposed key signs
      `accept_authority` (separate tx, no current-authority
      participation). After step 1 and **before** step 2, fetch the
      on-chain config and verify `pending_authority` matches the
      intended successor. A typoed proposal can be cancelled by
      passing `Some(Pubkey::default())` to `configure` or simply
      overwritten with another `configure` call — the current
      authority is in control until step 2 completes.

Config authority address: ___________________________
Same as upgrade authority? (Y/N): ___________________________

## 3. External security audit

The CPI flow into Wormhole Gateway / NTT / OnRe is the most novel surface
and the highest-impact place for subtle bugs. An external audit MUST review
at minimum:

- [ ] CPI allowlist (`programs/relayer/src/constants.rs`) — every program
      ID and instruction discriminator verified against canonical sources.
      **There is no automated test catching drift here**; the audit must
      manually verify each constant.
- [ ] `claim_usdc` positional account-binding guards (line 71-82) — defends
      against VAA-substitution between the named `posted_vaa` slot and the
      one TB reads positionally from `remaining_accounts`.
- [ ] `apply_fee_bps` overflow safety (`state.rs`) — checked u128 widening
      before multiplication.
- [ ] `init` constraints on every Flow PDA — confirm replay protection
      cannot be bypassed by passing a different bump or seed permutation.
- [ ] Outbound recipient is bound to `flow.fogo_sender` (parsed from a
      guardian-signed VAA), NOT a caller-supplied parameter. Since the
      flow instructions are permissionless on the **deposit** side
      (any wallet can crank `claim_usdc` / `swap_usdc_to_onyc` /
      `lock_onyc`), the caller MUST be unable to redirect transfers.
      Confirmed for the deposit chain. ⚠️ The withdraw chain
      (`unlock_onyc` / `swap_onyc_to_usdc` / `send_usdc_to_user`) is
      currently non-functional against live OnRe — see §4 — so the
      "permissionless caller cannot redirect" property is moot until
      that chain is redesigned. Once it is, re-audit this row.
- [ ] NTT session-authority delegation in `lock_onyc` — confirm the
      keccak-of-args binding prevents cross-call PDA reuse.

Audit firm: ___________________________
Report URL: ___________________________
Findings closed: ___________________________

## 4. Fixture / mainnet schema re-verification

`tests/utils/` ships pinned mainnet account fixtures (TB Config, MintSigner,
NTT Config, OnRe State, etc.) captured during development. If the upstream
program ships a state migration between fixture-capture and our deploy, the
relayer's parsing offsets will silently drift.

- [ ] Re-fetch each fixture from current mainnet (`solana account <pubkey>
      --output json`) and diff against `tests/utils/fixtures/*.json`.
      Layout changes require updating the parser AND re-running the LiteSVM
      e2e suite.
- [ ] **Withdraw chain has an architectural mismatch with the OnRe
      API.** Verified Apr 2026 against `onre-finance/onre-sol`: the
      relayer's `swap_onyc_to_usdc` CPIs `take_offer_permissionless`
      against an `Offer` PDA. OnRe does NOT model withdrawals as a
      symmetric back-direction `Offer` — it uses a separate
      `RedemptionOffer` account type with its own seed prefix and a
      two-step async flow (`create_redemption_request` →
      `fulfill_redemption_request`, with the fulfill leg gated on
      `boss || redemption_admin`). Mainnet state confirms the design:
      `[offer, ONyc, USDC]` (`HwWKn7CK…`) does NOT exist;
      `[redemption_offer, ONyc, USDC]` (`3pLK2vXD…`) DOES exist. There
      is no `take_redemption_offer_permissionless` analog. **The
      relayer cannot crank withdrawals against OnRe as currently
      coded** — `swap_onyc_to_usdc` would fail account-type validation
      against a `RedemptionOffer`. This is a HARD deploy-blocker for
      the withdraw path. Resolve by either: (a) splitting the relayer
      withdraw chain into `request_redemption` + `claim_redemption`
      with a new `RedemptionPending` Flow status (loses atomicity,
      adds soft dependency on OnRe's `redemption_admin` — revisit §8
      cranking model); or (b) coordinating with OnRe to ship a
      permissionless atomic counterpart to
      `take_offer_permissionless` for `RedemptionOffer`.
- [ ] Confirm Wormhole Core Bridge / Gateway / NTT / OnRe program IDs
      in `constants.rs` still resolve to deployed (non-frozen) programs on
      mainnet (`solana program show <pubkey>`).
- [ ] Re-verify the Wormhole chain ID for FOGO is still `51`.

## 5. NTT rate-limit production values

The LiteSVM tests zero out the rate-limit timestamps to make the fixtures
testable. In production, the on-chain NTT config enforces:

- [ ] **Outbound rate limit**: per-call cap and per-24h cap configured by
      the NTT manager admin. Confirm with the NTT operator that current
      values match the relayer's expected throughput. Document the active
      values:

      Per-call cap: ______________ ONyc
      Per-24h cap:  ______________ ONyc

- [ ] **Inbound rate limit**: same — confirm and document.

      Per-call cap: ______________ ONyc
      Per-24h cap:  ______________ ONyc

## 6. OnRe pricing-vector authority

The vault NAV depends on the OnRe price vector. Cached parameters update
rarely via Wormhole Queries or governance.

- [ ] Confirm who holds the price-vector update authority on the OnRe
      State PDA (mainnet). Document the address and any timelock /
      multisig structure.
- [ ] Confirm the relayer (and downstream OnRe vault) handles a frozen /
      stale price vector gracefully — either by failing closed or by
      pausing new deposits/withdrawals.

Update authority: ___________________________
Timelock / multisig: ___________________________

## 7. Devnet soak test

A handful of LiteSVM tests don't substitute for real-network multi-block
behavior (rent reclamation, slot transitions, NTT message attestation
windows).

- [ ] Deploy to devnet under the same upgrade-authority arrangement
      planned for mainnet.
- [ ] Run **at least 10** end-to-end deposit cycles (FOGO → claim_usdc →
      swap → lock_onyc) and **at least 10** end-to-end withdrawal cycles
      (FOGO → unlock_onyc → swap → send_usdc_to_user) over **at least
      72 hours**. ⚠️ The withdrawal-cycle half of this gate is
      **currently unrunnable** — `swap_onyc_to_usdc` has no valid
      OnRe target on devnet either (same protocol mismatch as
      mainnet, see §4). Cannot proceed past this item until the
      relayer withdraw chain is redesigned. Confirm:
      - All Flow PDAs close cleanly with rent returned to the original payer
      - No orphaned Flow PDAs after replay attempts
      - NTT rate-limit accumulators behave as expected across the
        24-hour window
      - Wormhole guardian attestation latency does not produce stuck flows
- [ ] Run a **failure-injection** pass on devnet: deliberate replay,
      wrong VAA, mismatched flow status. Confirm every failure surfaces
      a deterministic Anchor error and the relayer never partially
      mutates state.

## 8. Cranking infrastructure (no privileged key)

`claim_usdc`, `swap_*`, `lock_onyc`, `unlock_onyc`, `send_usdc_to_user`
are **permissionless** — anyone with enough SOL to pay the transaction
fee can call them, and that's by design. There is no operator / curator
key the system depends on. (See `SECURITY_MODEL.md` §4.2.)

> **⚠️ Withdraw chain caveat (Apr 2026)**: the deposit-side
> instructions (`claim_usdc`, `swap_usdc_to_onyc`, `lock_onyc`) are
> truly permissionless and the cranking decision below applies to
> them as written. The withdraw-side instructions (`unlock_onyc`,
> `swap_onyc_to_usdc`, `send_usdc_to_user`) are not currently
> runnable end-to-end (see §4). The cranker-roster decision below
> needs to be revisited only if §4 path (a) is taken — splitting the
> relayer withdraw chain into `request_redemption` +
> admin-fulfilled `claim_redemption`. That path introduces a soft
> dependency on OnRe's `redemption_admin` and the "no operator key
> the system depends on" claim no longer holds for the withdraw
> leg. If §4 path (b) is taken instead — OnRe ships a permissionless
> atomic counterpart to `take_offer_permissionless` for
> `RedemptionOffer` — the cranker model below stays valid as
> written. Decide §4 first, then this section.

What still needs to be decided before deploy:

- [ ] **Who runs the default cranker?** Pick one (or multiple — they
      can race harmlessly):

      - Off-chain bot operated by the deploying team (lowest latency,
        but creates a soft dependency).
      - Public bounty / MEV crank (anyone is incentivised to submit;
        no operational burden but unbounded latency on low-volume flows).
      - User self-crank in the SDK (each user pays for their own flow's
        rent and tx fees end-to-end).

      Selected approach: ___________________________

- [ ] **Whoever cranks pays rent for the Flow PDA.** The rent is
      returned to that same wallet when the flow closes (`lock_onyc`
      for deposits, `send_usdc_to_user` for withdrawals). Confirm the
      cranker has a SOL refill plan that covers the worst-case window
      between crank and close.
- [ ] **Stuck-flow alerting.** Whoever cranks is also responsible for
      noticing when a flow stalls (e.g. swap fails because the OnRe
      price vector is stale). There is no on-chain timeout. Document
      the monitoring runbook here:

      Alerting owner: ___________________________
      Stuck-flow SLO: ___________________________

## 9. CI / repo hygiene (informational)

These are known and benign as of the deploy snapshot but documented so the
on-call doesn't chase ghosts:

- The `bigint: Failed to load bindings, pure JS will be used` warning
  fires on every Node load of `@solana/spl-token`. It comes from the
  transitive `bigint-buffer` dep and is a benign perf fallback. Vitest
  hides it; raw `node` runs print it.
- `pnpm lint` reports ~2700 pre-existing `style/max-statements-per-line`
  errors. CI runs lint with `continue-on-error: true` until a dedicated
  lint-cleanup PR lands. None of these are correctness issues.
- `anchor build --verifiable` was deliberately skipped during the
  Apr 2026 hardening sprint and MUST be re-enabled in the deploy
  pipeline (see item 1).
- **`litesvm` is pinned to `^0.6.0`** in `package.json`. Litesvm 1.0
  is a sweeping breaking change (PublicKey objects → base58 Address
  strings across every API). Do not bump until `anchor-litesvm` ships
  a compatible release — otherwise every e2e test silently fails with
  empty logs.

---

## Apr 2026 hardening sprint addendum

This sprint added the following test coverage and codebase-checkable
verifications. The auto-verifiable items below are ticked because the
property is now enforced by a test (or a one-shot grep). Human-action
items in §1-§8 are NOT affected and still require deployer sign-off.

> **⚠️ Mid-sprint architectural finding**: while attempting to close
> the withdraw-chain test gap, the sprint discovered that the
> relayer's `swap_onyc_to_usdc` is mis-targeted against OnRe's
> actual API (it CPIs `take_offer_permissionless` against an `Offer`
> PDA that doesn't exist on the withdraw direction; OnRe's withdraw
> path uses a separate `RedemptionOffer` + admin-fulfilled
> `fulfill_redemption_request`). This is upgraded from "missing
> test coverage" to "missing relayer implementation against the
> real OnRe protocol". §4 is therefore not a sign-off item but a
> code-change-required item, and §7 (devnet soak) cannot be run
> for the withdraw cycles until that code change lands. See §4
> body and `docs/fogo-onre.md` top-of-file banner.

### Test-suite delta
- **vitest**: 52 → 58 passing (1 `it.todo` for the withdraw-chain
  e2e — **note**: the todo is not just a missing test, it documents
  the missing relayer implementation; see §4).
- **cargo unit tests** (`cargo test -p fogo-onre-relayer --lib`): 1 → 12
  passing — `apply_fee_bps` now covered for fee=0, fee=1 with rounding,
  fee=10000 / ZeroAmountFlow, gross=0, gross=u64::MAX with valid bps
  (u128 widening), out-of-range bps overflow → FeeOverflow,
  `RelayerConfig::validate` accept/reject bounds.
- **Position-binding negatives** added in `tests/relayer.test.ts`:
  PostedVaaMismatch, GatewayClaimMismatch (claim_usdc);
  TransceiverMessageMismatch, InboxItemMismatch, RecipientAtaMismatch
  (unlock_onyc). These were previously a zero-coverage gap — see §3.
- **Sweep mint-guard negative** added: rejects sweep of any mint that
  is neither `usdc_mint` nor `onyc_mint`.

### Auto-verified items (re-tick on every release)
- [x] §1.2 Program ID consistency: `Anchor.toml` (all clusters),
      `programs/relayer/src/lib.rs` `declare_id!`, and
      `target/deploy/fogo_onre_relayer-keypair.json` pubkey all resolve
      to `onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp` as of this
      addendum date.
- [x] §1.3 `cargo test -p fogo-onre-relayer --lib` — 12/12 passing.
- [x] §4 CPI program IDs in `programs/relayer/src/constants.rs`
      match the canonical mainnet addresses for: Wormhole Core
      (`worm2Zo…`), Token Bridge / Gateway (`wormDTU…`), NTT
      (`nttu74…`), OnRe (`onreuGh…`). FOGO Wormhole chain ID = 51.

### Items still requiring human sign-off
- §1.1 verifiable build (Docker-pinned toolchain)
- §1.4 manual diff of `constants.rs` vs prior release
- §2 / §2b upgrade & config authority handling (multisig roster)
- §3 external audit
- §4 (continued) mainnet fixture re-fetch & diff; **withdraw chain
  is architecturally incompatible with OnRe's `RedemptionOffer` API**
  (verified Apr 2026 against `onre-finance/onre-sol`) — relayer
  redesign or OnRe protocol extension required before withdraws can
  ship.
- §5 NTT rate-limit production values
- §6 OnRe pricing-vector update authority
- §7 devnet soak test (≥10 deposit + ≥10 withdraw cycles, ≥72 h, plus
  failure-injection)
- §8 cranking infrastructure decision

---

## Sign-off

I, _______________________ (printed name),
acting as _______________________ (role),
confirm every applicable box above is ticked and certify this build is
ready for mainnet deploy.

Signature: ___________________________   Date: _______________
