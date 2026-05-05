# Security Model

This document captures the trust boundaries of the fogo-onre relayer
program: which keys exist, what each can do, and what happens if each is
compromised.

The relayer's headline property — **"the relayer has no privileged caller"** —
means every flow-driving instruction (`claim_usdc`, `swap_usdc_to_onyc`,
`lock_onyc`, `unlock_onyc`, `request_redemption_onyc`,
`claim_redemption_usdc`, `send_usdc_to_user`) is **permissionless**: any
wallet on the network can submit them. Safety does not depend on who pays
the transaction fee. This is the result of several layered design choices
documented here. None of the layers individually is sufficient; the model
assumes all are in place.

> **Withdraw-chain soft dependency.** The withdraw redemption is async:
> `request_redemption_onyc` enqueues a `RedemptionRequest` with OnRe;
> OnRe's `redemption_admin` then fulfills it asynchronously, after which
> anyone can call `claim_redemption_usdc`. The relayer cannot force
> fulfillment — if `redemption_admin` is unavailable the request stalls.
> `cancel_redemption_onyc` (config-authority gated) is the escape hatch
> and refunds ONyc to the user; per-cycle fee skim is capped at
> `withdraw_fee_bps` (≤ `MAX_FEE_BPS` = 10%). See §3 (OnRe row) and
> §4.2.5 for the full bound.

---

## 1. Key inventory

| Key                             | Holder                            | Lifecycle                                                                                                                                                                                                                                   | On-chain capability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Upgrade authority**           | Multisig (or `None` if immutable) | Set at deploy, never rotated                                                                                                                                                                                                                | Can replace the relayer `.so`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Config authority**            | Set at `initialize` time          | Two-step rotation: `configure` proposes (current authority signs); `accept_authority` finalizes (proposed key signs, separately). The two parties never need to sign the same transaction — supports independent multisig→multisig handoff. | **Set fees up to `MAX_FEE_BPS` (10%) per leg with 2-day timelock on increases, redirect `fee_vault` to attacker-controlled account, cancel an in-flight redemption (skims fees per cycle), propose+accept-rotate authority to attacker key.** See §4.2.5 — bounded blast radius. Cannot drain operating ATAs (no instruction lets the authority sign for `usdc_ata` / `onyc_ata` outflows; only the handler chain bound to specific `Flow` PDAs can), cannot redirect per-flow outbound recipients (those are bound to `flow.fogo_sender`), cannot bypass `MAX_FEE_BPS`. |
| **OnRe price-vector authority** | OnRe governance / multisig        | OnRe-controlled, not in this repo                                                                                                                                                                                                           | Updates ONyc price parameters that the OnRe vault reads via Wormhole Queries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **NTT manager admin**           | Wormhole Foundation / OnRe ops    | Wormhole-controlled, not in this repo                                                                                                                                                                                                       | Adjusts NTT rate limits, registered transceivers, peers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Wormhole guardians**          | 19 Wormhole guardian set          | Rotated by Wormhole governance                                                                                                                                                                                                              | Sign VAAs that the relayer consumes via Token Bridge / NTT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **OnRe boss**                   | OnRe governance                   | OnRe-controlled, not in this repo                                                                                                                                                                                                           | Receives token-in fees on `take_offer_permissionless`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

There is **no operator / curator / cranker key** in the relayer's trust
model. Anyone with enough SOL to pay the transaction fee can submit any
flow-driving instruction. This is intentional: making cranking
permissionless eliminates an entire class of "what if the operator is
malicious / unavailable / compromised" failure modes.

The relayer program itself owns **no keys** — every long-lived authority
on its accounts is a PDA derived from the program ID + a fixed seed.
There is no "admin" with elevated access to relayer state.

## 2. PDA inventory

Every account the relayer authorities over is a PDA. The seeds are
defined in `programs/relayer/src/constants.rs` and mirrored in the SDK.

| PDA                   | Seeds                                                                                               | Owner / signer  | Purpose                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| Relayer authority     | `[b"relayer"]`                                                                                      | Relayer program | Owns the long-lived USDC and ONyc ATAs; signs every outbound CPI.                               |
| Redeemer              | `[b"redeemer"]`                                                                                     | Relayer program | Per-claim signer for TB `CompleteWrappedWithPayload`; owns the short-lived intake USDC ATA.     |
| Config                | `[b"relayer_config"]`                                                                               | Relayer program | Stores `usdc_mint`, `onyc_mint`, fee BPS, fee vault. Settable only by the configured authority. |
| Inbound Flow          | `[b"inflight", gateway_claim_pubkey]`                                                               | Relayer program | Receipt for an in-progress deposit. Init-once on `claim_usdc`.                                  |
| Outbound Flow         | `[b"outflight", ntt_inbox_pubkey]`                                                                  | Relayer program | Receipt for an in-progress withdrawal. Init-once on `unlock_onyc`.                              |
| NTT session authority | `[b"session_authority", sender, keccak(transfer_args)]` (under `NTT_PROGRAM_ID`, not the relayer's) | NTT program     | Per-call delegate for `transfer_lock`.                                                          |

**Key property**: every Flow PDA is seeded by the _bridge's own
per-message claim/inbox PDA_, which is itself created via CPI by the
bridge program. A caller cannot forge a Flow seed without first having
the bridge accept a guardian-signed VAA — i.e., replay protection is
inherited from Wormhole.

## 3. Trust boundaries

### Wormhole guardians (19-of-19 threshold for governance, 13-of-19 for messages)

Trusted to honestly attest source-chain events. Compromise of ≥13 guardian
keys would let an attacker forge a `claim_usdc` VAA and direct minted USDC

- associated bONyc to an attacker-controlled FOGO address. Outside the
  relayer's control; mitigated by Wormhole's own operational security.

### Wormhole Token Bridge / Gateway program

Trusted to correctly mint wrapped USDC, manage the wrapped-mint authority,
and enforce the redeemer-PDA pattern. The relayer hardcodes the program
ID (`wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb`) and the instruction
discriminator as `pub const` values in `programs/relayer/src/constants.rs`.
A future PR swapping these would compile and pass CI silently — code
review of `constants.rs` diffs is the only defense (see §7).

### NTT manager program

Trusted to correctly lock ONyc into custody on outbound and release on
inbound. Same pinning treatment as Gateway. Relayer also encodes the
positional `redeem_accounts_len` split that NTT expects — see
`InvalidAccountSplit` in `claim_usdc.rs`.

### OnRe program

Trusted to honor `take_offer_permissionless` semantics on the **deposit**
leg: USDC in → ONyc out at the published price, plus apply OnRe's own
fee. The relayer does not validate the OnRe price calculation; it trusts
whatever ONyc amount `take_offer_permissionless` deposits to the
relayer's authority-owned ATA, then applies the deposit fee on the
post-swap output.

On the **withdraw** leg the trust shape is different: there is no
permissionless symmetric counterpart. OnRe models withdrawals as a
`RedemptionOffer` with a two-step async flow
(`create_redemption_request` → `fulfill_redemption_request`, the latter
gated on `boss || redemption_admin`). The relayer's
`request_redemption_onyc` enqueues the request and snapshots
`usdc_ata`; once OnRe's `redemption_admin` fulfills, anyone can call
`claim_redemption_usdc`, which credits the snapshot delta to the
flow. **OnRe's `redemption_admin` is therefore a liveness dependency
on the withdraw leg** — they cannot redirect funds (the redemption
PDA is bound at request time and verified on claim) but they can
indefinitely stall fulfillment. The escape hatch is
`cancel_redemption_onyc` (§4.2.5).

### OnRe price-vector authority

A malicious or buggy price update could mint fewer wONyc shares than
deposits warrant (or more). Outside the relayer's control; mitigated by
OnRe's governance + the OnRe vault's defensive caps on per-block NAV
movement.

## 4. Attack surface — what each compromised key can do

### 4.1 Compromised upgrade authority

**Blast radius: TOTAL.** The attacker can ship a new relayer `.so` that
ignores every safety check below. They can drain the relayer's
authority-owned USDC and ONyc ATAs, redirect outbound transfers to any
address, and forge Flow PDAs to defraud the FOGO-side vault.

**Mitigations:**

- Set upgrade authority to `None` (immutable) at deploy, OR transfer to
  a hardware-backed multisig with public threshold.
- Never leave on a single hot key. See `deploy-checklist.md` §2.

### 4.2 Malicious / arbitrary caller of a flow instruction

**Blast radius: ~ZERO.** The flow instructions are permissionless — any
wallet can submit them, and that's by design. Every safety-critical input
(`fogo_sender`, `gateway_claim`, `ntt_inbox_item`, the in-flight token
amount) is parsed from a guardian-signed VAA or a CPI-created bridge PDA,
not from a caller-supplied parameter. The caller cannot:

- Choose the outbound recipient — `lock_onyc` and `send_usdc_to_user`
  read `flow.fogo_sender` (parsed from the VAA on `claim_usdc` /
  `unlock_onyc`), not a parameter.
- Forge a Flow PDA — Flow seeds include the bridge's CPI-created
  claim/inbox PDA; nobody can create that without first feeding a real
  guardian-signed VAA through the bridge.
- Skip or reorder the steps — `swap_usdc_to_onyc` requires `flow.status
  == Claimed` and transitions to `Swapped`; `lock_onyc` requires
  `Swapped`. Each handler emits an `emit!` event so misordered attempts
  are visible on-chain.
- Drain the long-lived USDC / ONyc ATAs — the relayer authority PDA
  signs all CPIs; an external wallet has no signing power over PDAs.
- Pocket the fee — fees are routed to the configured `fee_vault` (set
  by the config authority at `initialize` / `configure` time), not to
  the caller.

**Worst case from a malicious caller:**

- Submit junk transactions that fail and burn their own SOL.
- Race a legitimate caller to crank a flow (no harm — outcome is the
  same; the loser pays a failed-tx fee).
- Reclaim rent from a Flow PDA they themselves paid for after the flow
  completes (this is the normal close path; rent is returned to
  whichever wallet originally paid for the PDA).

A caller paying for a Flow PDA on someone else's deposit cannot
withhold rent reclamation maliciously — `lock_onyc` / `send_usdc_to_user`
close the PDA atomically with the final CPI, returning rent to the
original payer. The original payer's wallet is recorded in the Flow PDA
at init time.

This is the system's headline property. It depends on §4.1 holding —
if the attacker has the upgrade authority, none of this matters.

### 4.2.5 Compromised config authority

**Blast radius: BOUNDED.** The config authority is set at `initialize`
and rotatable only via `configure`. No instruction in the program lets
the authority sign for `usdc_ata` / `onyc_ata` outflows — operating
ATAs are touchable only by the flow-handler chain, bound to specific
`Flow` PDAs. A compromised config authority can:

- **Set fees up to `MAX_FEE_BPS` (10%) per leg.** `validate()` rejects
  any value above the constant on both live and staged fields, so the
  worst case is 10% per leg / ~19% round-trip. Increases require the
  `FEE_TIMELOCK_SLOTS` (~2 days) timelock; decreases apply instantly.
- **Redirect `fee_vault` to an attacker-controlled account.** The fee
  vault is an account address stored in config; rotation applies
  immediately. All subsequent fee skims (capped at 10%) flow to the
  new vault.
- **Cancel an in-flight withdraw redemption.** `cancel_redemption_onyc`
  is authority-gated; per-cycle fee skim is capped at the live
  `withdraw_fee_bps`. A request→cancel grief loop bleeds the user at
  most `withdraw_fee_bps` per round-trip.

**What the config authority CANNOT do:**

- **Drain operating ATAs.** No instruction in the program lets the
  authority sign for `usdc_ata` / `onyc_ata` outflows. The
  `relayer_authority` PDA is signed for only by handler-chain logic
  bound to specific `Flow` PDAs.
- **Bypass `MAX_FEE_BPS`.** `validate()` enforces the cap at every
  configure call, on both live and staged fields.
- **Redirect a specific flow's outbound recipient.** `lock_onyc` and
  `send_usdc_to_user` read `flow.fogo_sender` (parsed from the VAA at
  `claim_usdc` / `unlock_onyc` time), not from config.
- **Forge a Flow PDA or skip status guards.** Those are enforced by
  the program logic, not by config.
- **Replace the program.** That requires the upgrade authority (§4.1).

**Rotation:** Two-step propose/accept, designed for multisig → multisig
handoff where the two parties cannot easily co-sign one transaction.

1. **Propose** — current authority calls
   `configure(new_authority=Some(pk))`. This writes `pk` to
   `config.pending_authority`; `config.authority` is unchanged.
   Re-proposing overwrites the prior pending value.
   `Some(Pubkey::default())` cancels any in-flight proposal
   (clears `pending_authority` to `None`).
2. **Accept** — the proposed key signs `accept_authority` in a
   separate transaction. The handler verifies the signer equals
   `pending_authority`, then atomically copies pending into
   `authority` and clears the pending slot. The current authority
   does not participate.

This design **eliminates the typo-brick class**: a typo in step 1
just sits in the pending slot until either the current authority
overwrites/cancels it, or somebody who happens to control the typoed
key signs `accept_authority`. Until step 2 succeeds, the current
authority retains full control.

A compromised config authority can still rotate to an attacker-controlled
key by proposing the attacker's key and waiting for the attacker to
accept. This both **locks the legitimate operator out** and survives
any subsequent revocation of the original compromised key. The
fund-loss blast radius is bounded by `MAX_FEE_BPS` (≤10% per leg) and
the fee timelock; recovery from operator-lockout requires an
upgrade-authority redeploy.

**Mitigations:**

- Set the config authority to a hardware-backed multisig at
  `initialize` time. The same multisig that holds the upgrade
  authority is the natural choice — there is no operational reason to
  separate them, and using the same one avoids the "compromise either
  one is total" footgun.
- Never leave on a single hot key. While the cap and timelock bound
  the per-cycle damage, an attacker who holds the authority for an
  extended period can still siphon up to 10% of every flow until
  noticed.
- For a planned rotation: after step 1, **fetch on-chain config and
  verify `pending_authority` matches the intended successor** before
  the successor signs `accept_authority`. The two-step design lets you
  catch a misproposal before it commits.

### 4.3 Compromised OnRe price-vector authority

**Blast radius: NAV manipulation.** The attacker can update the ONyc
price to mint inflated wONyc shares to depositors (or deflated ones,
gating withdrawals).

**Mitigations:** outside this repo. Belongs to OnRe + the OnRe vault
program's defensive NAV caps. Documented here so the on-call knows the
key exists.

### 4.4 Compromised NTT manager admin

**Blast radius: rate-limit changes.** The admin can raise or lower NTT
rate limits, which throttles legitimate flows but cannot redirect them.
A malicious admin could DoS the relayer by setting limits to zero.

**Mitigations:** outside this repo (Wormhole + OnRe operational
security). The relayer fails closed when NTT rejects a transfer for
rate-limit reasons.

### 4.5 Compromised Wormhole guardians (≥13-of-19)

**Blast radius: cross-chain inbound flows can be forged.** The attacker
can craft a VAA that the bridge will accept; the relayer will then
mint+lock+credit a FOGO recipient of the attacker's choosing. The
relayer cannot defend against this — it inherits the trust of the
underlying bridge.

**Mitigations:** Wormhole's own guardian-set governance. The fogo-onre
vault may layer additional defenses (e.g., per-block deposit caps).

## 5. Replay protection

Two independent layers:

1. **Bridge-side**: Wormhole Token Bridge creates a `gateway_claim` PDA
   on `CompleteWrappedWithPayload`; NTT creates an `inbox_item` PDA on
   `redeem`. Both are init-once and serve as the bridge's own replay
   protection.
2. **Relayer-side**: every Flow PDA is `init` (not `init_if_needed`)
   with seeds bound to the bridge PDA from layer 1. A second
   `claim_usdc` for the same VAA fails with the system program's
   `already in use` error before any CPI runs. This is asserted by
   `claim_usdc rejects replay when inflight Flow PDA already exists`
   in `tests/relayer.test.ts`.

A bug in either layer alone would not enable replay. Both must fail
simultaneously.

## 6. Fee-math safety

`apply_fee_bps` (`programs/relayer/src/state.rs`) widens to `u128`
before multiplication and uses `checked_mul` / `checked_sub` throughout.
The fee BPS is bounded at config time by `FeeBpsTooHigh` (max
`MAX_FEE_BPS = 1000` = 10%). Net amount is required `> 0` after fee
application — zero-amount flows are explicitly rejected.

A future change that swaps `checked_mul` for `*` or removes the u128
widening would silently allow overflow. There is no test that asserts
on the panic-free property; reviewers must catch this in PR review.

## 7. CPI allowlist (compile-time pinning only)

The relayer's CPI destinations are hardcoded `pub const Pubkey` values
in `programs/relayer/src/constants.rs`. This gives:

- **Compile-time pinning** — the program ID is baked into the `.so`,
  not loaded from an account. No way to redirect at runtime.

That is the _only_ defense. There is no automated CI alarm on changes
to these constants. A malicious PR that swaps a CPI destination would
compile, pass clippy, pass every other test, and ship — protection
relies entirely on a human reviewer noticing the diff in `constants.rs`.

**Reviewer responsibilities for any PR touching `constants.rs`:**

- Diff every changed `pub const Pubkey` against the canonical mainnet
  source (Wormhole / OnRe / NTT docs linked in each const's doc
  comment).
- Diff every changed instruction tag / sighash against the upstream
  program's IDL or source.
- A typo in the constants is indistinguishable from sabotage at this
  layer — when in doubt, block the PR and ask the author for the
  canonical source URL.

The on-chain program re-validates account _owners_ and _addresses_ via
Anchor constraints, so SDK-side drift cannot land funds at a wrong
destination — but if the on-chain `pub const` itself is swapped, the
program would happily CPI into the wrong place. There is no further
runtime check.

## 8. What this model does NOT cover

- **The FOGO-side OnRe vault program.** Its security model is documented
  separately. The relayer assumes the vault correctly accounts for
  reserve + bONyc backing and computes NAV defensively.
- **The bridge programs themselves.** Wormhole Gateway, NTT, and OnRe
  are external dependencies; the relayer trusts their published
  semantics.
- **Off-chain monitoring.** Whoever chooses to crank flows is responsible
  for their own infrastructure (alerting on stuck flows, retry logic).
  No on-chain role exists for them.
- **Economic attacks.** MEV ordering between `claim_usdc` and the
  swap, oracle manipulation of the OnRe price vector, etc., are out
  of scope.

---

## Quick reference for incident response

| Symptom                                               | Likely cause                                                                                                                 | First action                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constants.rs` diff in PR review                      | Possible CPI redirection (intentional or malicious)                                                                          | Diff every changed `pub const Pubkey` and instruction tag against the canonical source linked in each const's doc comment. There is no automated test catching this — reviewer attention is the only line of defense.                                                                                                                          |
| Flow PDA stuck in `Claimed`                           | Deposit-leg swap CPI failed (price vector stale, NTT/OnRe rate limit, OnRe paused)                                           | Diagnose the upstream condition. Re-crank `swap_usdc_to_onyc` permissionlessly once it clears — funds remain in the relayer's authority-owned ATA and resume on the next successful swap. No cancel path; recovery is "wait for upstream + retry".                                                                                             |
| Flow PDA stuck in `Swapped`                           | NTT lock CPI failed (rate limit, custody account state) — deposit, OR `request_redemption_onyc` not yet submitted — withdraw | Deposit: check NTT outbox rate limit; re-crank `lock_onyc` once it clears. Withdraw: re-crank `request_redemption_onyc` permissionlessly. Same caveat — no cancel path on the deposit side.                                                                                                                                                    |
| Flow PDA stuck in `RedemptionPending`                 | OnRe `redemption_admin` has not fulfilled the request yet                                                                    | Verify the `RedemptionRequest` PDA still exists and matches `RedemptionTracker.redemption_request`. If fulfilled, anyone can call `claim_redemption_usdc`. If unfulfilled and indefinitely stalled, the config authority can call `cancel_redemption_onyc` to refund ONyc to the user (per-cycle skim ≤ `withdraw_fee_bps`).                   |
| `already in use` error on `claim_usdc`                | Replay attempt OR legitimate retry of a flow already created                                                                 | Inspect the existing Flow PDA — if it's at `Claimed`/`Swapped` for the same VAA, this is normal idempotence. No double-spend possible because the bridge's own `gateway_claim` PDA is also init-once.                                                                                                                                          |
| Permanently stuck flow (upstream broken indefinitely) | OnRe / NTT discontinued, frozen mint, etc.                                                                                   | **There is no on-chain recovery path.** Funds in the in-flight ATAs require an upgrade-authority action (deploy a patched program with a one-shot rescue instruction, or migrate state to a new program). This is a known limitation of the v1 relayer — see `deploy-checklist.md` §6 for the OnRe/NTT availability assumptions this rests on. |
| Upgrade authority compromised                         | Per §4.1 — emergency                                                                                                         | If immutable: not possible. If multisig: revoke compromised signer; freeze deploys.                                                                                                                                                                                                                                                            |
