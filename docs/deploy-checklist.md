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
- [x] Compare the program ID embedded in the binary (`anchor keys list`)
      to the canonical `onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp` in
      `Anchor.toml` and `programs/relayer/src/lib.rs`. They MUST match.
      _(Auto-verified: `Anchor.toml` (all clusters) and `declare_id!`
      resolve to the canonical pubkey on every CI run.)_
- [x] Run `cargo test -p fogo-onre-relayer --lib` and confirm all unit
      tests pass. _(Auto-verified by CI: 30/30 currently passing.)_
- [ ] **Manually diff `programs/relayer/src/constants.rs`** in the deploy
      commit against the previous release. There is no automated CI
      alarm on changes to the CPI program IDs or instruction tags — a
      malicious or accidental swap would compile and ship silently.
      Verify every `pub const Pubkey` against the canonical mainnet
      source linked in its doc comment.
- [ ] **`RelayerConfig` migration check.** The on-chain account layout
      can grow across releases (e.g. the timelock rollout appended
      `pending_fee: Option<PendingFee>`). Any cluster (localnet,
      devnet, mainnet) that ran a prior `initialize` against this
      program ID may hold an under-sized PDA that fails to deserialize
      until reallocated. This build does NOT ship a
      `migrate_relayer_config` instruction. For each cluster this
      program ID has touched, confirm the PDA either (a) was
      re-`initialize`d after the schema change, or (b) was reallocated
      via a one-shot upgrade. New clusters are unaffected.

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
Multisig address (if applicable):___________________________
Signer roster (if applicable): ___________________________

### 2b. Config authority

The `config authority` (set at `initialize`, rotatable only via `configure`)
has **bounded but non-trivial blast radius**: it can set fees up to
`MAX_FEE_BPS` (10%) per leg with a 2-day timelock on increases, redirect
`fee_vault` to an attacker-controlled account, cancel an in-flight
redemption (skims fees per cycle), and rotate the authority key. It
**cannot** drain operating ATAs (no instruction lets the authority sign
for `usdc_ata` / `onyc_ata` outflows) or bypass `MAX_FEE_BPS`. See
`security.md` §4.2.5 for the full attack surface.

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
Same as upgrade authority? (Y/N):___________________________

## 3. External security audit

The CPI flow into Wormhole NTT (USDC.s + ONyc managers) and OnRe is the
most novel surface and the highest-impact place for subtle bugs. The
relayer does **not** CPI Wormhole Core or the legacy Token Bridge /
Gateway — that path was removed in the NTT migration. An external audit
MUST review at minimum:

- [ ] CPI allowlist (`programs/relayer/src/constants.rs`) — every program
      ID and instruction discriminator verified against canonical sources.
      **There is no automated test catching drift here**; the audit must
      manually verify each constant.
- [ ] `claim_usdc` positional account-binding guards — defends against
      VAA-substitution between the named `posted_vaa` slot and the one
      TB reads positionally from `remaining_accounts`.
- [ ] `unlock_onyc` positional pins (`transceiver_message`,
      `inbox_item` ×2, `recipient_ata`) — same shape as `claim_usdc`.
- [ ] `request_redemption_onyc` ONyc balance-delta check — pre/post
      `onyc_ata` snapshot enforces that OnRe consumed `gross` ONyc from
      the relayer's ATA, defeating cranker substitution at OnRe's
      `redeemer` slot.
- [ ] `cancel_redemption_onyc` redemption-request pinning —
      `cpi_redemption_request_key == tracker.redemption_request`
      enforces the cancel targets the bound request, not a substitute.
- [ ] `apply_fee_bps` overflow safety (`state.rs`) — checked u128 widening
      before multiplication.
- [ ] `init` constraints on every Flow PDA AND the singleton
      `RedemptionTracker` — confirm replay protection cannot be
      bypassed by passing a different bump or seed permutation.
- [ ] Outbound recipient is bound to `flow.fogo_sender` (parsed from a
      guardian-signed VAA), NOT a caller-supplied parameter. The flow
      instructions are permissionless; the caller MUST be unable to
      redirect transfers.
- [ ] NTT session-authority delegation in `lock_onyc` — confirm the
      keccak-of-args binding prevents cross-call PDA reuse.

Audit firm: ___________________________
Report URL:___________________________
Findings closed: ___________________________

## 4. Fixture / mainnet schema re-verification

`tests/utils/` ships pinned mainnet account fixtures (NTT USDC.s Config /
peer / rate limits, NTT ONyc Config, OnRe State, OnRe `RedemptionOffer`,
etc.) captured during development. If an upstream program ships a state
migration between fixture-capture and our deploy, the relayer's parsing
offsets will silently drift.

- [ ] Re-fetch each fixture from current mainnet (`solana account <pubkey>
      --output json`) and diff against `tests/utils/fixtures/*.json`.
      Layout changes require updating the parser AND re-running the LiteSVM
      e2e suite.
- [x] CPI program IDs in `programs/relayer/src/constants.rs` match the
      canonical mainnet addresses for: NTT USDC.s manager (`nttu74…`,
      `constants.rs:9`), NTT ONyc manager (`nttpna5vXW7…`,
      `constants.rs:12`), OnRe (`onreuGh…`, `constants.rs:6`), FOGO
      `intent_transfer` (`Xfry4d…`, `constants.rs:129`). FOGO Wormhole
      chain ID = 51. Wormhole Core / Token Bridge / Gateway IDs are
      deliberately absent — the relayer doesn't CPI them. _(Auto-verified
      by the `constants.rs` discriminator/sighash tests; the
      `RelayerConfig::INIT_SPACE` pin test guards layout drift.)_
- [ ] Confirm each program above still resolves to a deployed
      (non-frozen) program on mainnet (`solana program show <pubkey>`).
      The ONyc NTT manager (`nttpna5vXW7…`) in particular may not be
      live yet at the time of relayer deploy; if so, deploy-mainnet.md
      §7.1 must run **before** the smoke test.
- [ ] Confirm OnRe's `RedemptionOffer` PDA for the ONyc/USDC pair
      (`3pLK2vXD…`) still exists and is funded with USDC sufficient to
      cover expected withdraw volume. The withdraw chain depends on
      OnRe's `redemption_admin` fulfilling against this offer; an
      empty or de-listed offer indefinitely stalls every withdrawal
      until cancelled via `cancel_redemption_onyc`.

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
Timelock / multisig:___________________________

## 7. Devnet soak test

A handful of LiteSVM tests don't substitute for real-network multi-block
behavior (rent reclamation, slot transitions, NTT message attestation
windows, OnRe `redemption_admin` fulfillment latency).

- [ ] Deploy to devnet under the same upgrade-authority arrangement
      planned for mainnet.
- [ ] Run **at least 10** end-to-end deposit cycles (FOGO → `claim_usdc`
      → `swap_usdc_to_onyc` → `lock_onyc`) over **at least 72 hours**.
      Confirm:
  - All Flow PDAs close cleanly with rent returned to the original payer
  - No orphaned Flow PDAs after replay attempts
  - NTT rate-limit accumulators behave as expected across the
    24-hour window
  - Wormhole guardian attestation latency does not produce stuck flows
- [ ] Run **at least 10** end-to-end withdrawal cycles (FOGO →
      `unlock_onyc` → `request_redemption_onyc` → OnRe admin fulfill
      → `claim_redemption_usdc` → `send_usdc_to_user`) over **at least
      72 hours**. Confirm additionally:
  - The singleton `RedemptionTracker` PDA correctly serializes
    concurrent withdraw attempts (second `request_redemption_onyc`
    fails until the first clears or is cancelled)
  - OnRe's devnet `redemption_admin` fulfills within an
    operationally acceptable window; document the observed latency
  - `cancel_redemption_onyc` returns the user's ONyc cleanly when
    exercised on a stalled request
- [ ] Run a **failure-injection** pass on devnet: deliberate replay,
      wrong VAA, mismatched flow status, cranker-substituted redeemer
      slot in `request_redemption_onyc`. Confirm every failure surfaces
      a deterministic Anchor error and the relayer never partially
      mutates state.

## 8. Cranking infrastructure

Every flow-driving instruction (`claim_usdc`, `swap_usdc_to_onyc`,
`lock_onyc`, `unlock_onyc`, `request_redemption_onyc`,
`claim_redemption_usdc`, `send_usdc_to_user`) is **permissionless** —
anyone with enough SOL to pay the transaction fee can call them. There is
no operator / curator key the relayer depends on for forward progress on
its own instructions. (See `security.md` §4.2.)

The withdraw chain has a **liveness** dependency on OnRe's
`redemption_admin` to fulfill `RedemptionRequest`s asynchronously. The
admin cannot redirect funds (the request PDA is bound at request time
and verified on claim) but can stall fulfillment indefinitely. The
escape hatch is `cancel_redemption_onyc`, gated on the relayer's own
config authority. Plan accordingly.

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

- [ ] **Whoever cranks pays rent for the Flow PDA and
      `RedemptionTracker`.** The rent is returned to that same wallet
      when the flow / tracker closes (`lock_onyc` for deposits,
      `claim_redemption_usdc` or `cancel_redemption_onyc` for the
      tracker, `send_usdc_to_user` for the outbound Flow). Confirm
      the cranker has a SOL refill plan that covers the worst-case
      window between crank and close — particularly the withdraw
      chain, where the tracker holds rent until OnRe fulfills.
- [ ] **Stuck-flow alerting.** Whoever cranks is also responsible for
      noticing when a flow stalls (swap fails because the OnRe price
      vector is stale, NTT rate limit exhausted, OnRe
      `redemption_admin` unresponsive, etc.). There is no on-chain
      timeout. Document the monitoring runbook here:

      Alerting owner: ___________________________
      Stuck-flow SLO: ___________________________
      Cancel-redemption decision authority: ___________________________

## 9. CI / repo hygiene (informational)

These are known and benign as of the deploy snapshot but documented so the
on-call doesn't chase ghosts:

- The `bigint: Failed to load bindings, pure JS will be used` warning
  fires on every Node load of `@solana/spl-token`. It comes from the
  transitive `bigint-buffer` dep and is a benign perf fallback. Vitest
  hides it; raw `node` runs print it.
- `pnpm lint` reports pre-existing `style/max-statements-per-line`
  errors. CI runs lint with `continue-on-error: true` until a dedicated
  lint-cleanup PR lands. None of these are correctness issues.
- **`litesvm` is pinned to `^0.6.0`** in `package.json`. Litesvm 1.0
  is a sweeping breaking change (PublicKey objects → base58 Address
  strings across every API). Do not bump until `anchor-litesvm` ships
  a compatible release — otherwise every e2e test silently fails with
  empty logs.

---
