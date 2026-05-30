# Intent-fork cross-program replay: the economic-irrationality argument

**Status:** accepted risk, no on-chain replay gate. Open Q5 from
`docs/tmp/superpowers/specs/2026-05-29-onre-intent-program-design.md`.

## The vector

Both legs (USDC deposit, ONyc redeem) route through
`intent_transfer.bridge_ntt_tokens`. The user signs an intent message and
a paymaster sponsor co-signs and lands the transaction. The intent
message does **not** bind the `sponsor`: nothing in the signed bytes names
who pays gas or submits the transaction.

The OnRe fork (`inTFf5S7ZtYr8SkwGG85mjDwAyJwjqEPdH2p2nuyrL9`) is
source-identical to Fogo's `intent_transfer`
(`Xfry4dW9m42ncAqm8LyEnyS5V6xu5DSJTMRQLiGkARD`) except `declare_id!`. The
relayer pins inbound NTT senders to a permanent two-element allowlist
`{OnRe-setter, Fogo-setter}` (`allowed_intent_setters()` in
`programs/relayer/src/constants.rs`) so a deposit/redeem that originated
through _either_ program is accepted on Solana.

So a third party who observes a user's signed intent can, before it
lands, replay it against the **dormant** program (Fogo's, which we no
longer route through) and become the sponsor. The relayer accepts it
because the Fogo setter is allowlisted.

## Why this is bounded — economically irrational, not exploitable

1. **The recipient is the signed user inbox, not the replayer.** The
   NTT `recipient_address` is the per-user inbox PDA
   (`findUserInboxAuthorityPda(wallet, RELAYER_PROGRAM_ID)`), which is a
   field of the _signed_ message. A replay cannot redirect funds — it
   delivers to exactly the inbox the user signed for. There is no theft
   primitive here; the replayer cannot name themselves as recipient
   without invalidating the user's signature.

2. **A replay sponsor pays and gains nothing.** Sponsoring a replay costs
   the replayer FOGO gas plus the bridge fee, and the only effect is
   delivering the user's own funds to the user's own inbox. The replayer
   captures no value — they have simply paid to perform the user's
   transaction for them.

3. **Single-active-program sponsorship.** Our paymaster sponsors only the
   active program (`FOGO_BRIDGE_PAYMASTER_DOMAIN` / `OnReBridge` shaped
   for the OnRe fork). It will not co-sponsor a submission shaped for the
   dormant program, so the replayer must fund the gas themselves — which
   is exactly the cost in (2).

4. **Backend already-used-intent guard.** The sponsor service refuses to
   co-sponsor an intent whose hash it has already sponsored, so it cannot
   be tricked into paying for both the genuine submission and a replay.
   _(Ops/infra — see boundary below.)_

5. **Short intent validity.** Intents are sponsored only within a short
   window, so a captured-but-unlanded intent cannot be replayed later.
   _(Ops/infra — see boundary below.)_

6. **Replay monitoring.** The cranker flags any inbound VAA whose NTT
   sender is the dormant program's setter PDA
   (`cranker_intent_replay_observed_total{leg}`, emitted by
   `packages/cranker/src/relayer/replay-monitor.ts`). Under normal
   operation this counter stays at zero; any increment is a cross-program
   replay signal an operator alert fires on. This is the in-repo
   realization of mitigations (4)/(5): even where the economic argument
   already makes replay pointless, we still _see_ it.

## Conclusion

The unpinned `sponsor` permits cross-program replay against the dormant
program, but replay cannot steal funds (recipient is signed), cannot be
profitable (replayer pays gas + fee to move the user's funds to the
user's own inbox), and is observable (monitoring metric). An on-chain
replay gate would add audited-fork surface for no security gain. We
therefore accept the risk without an on-chain gate.

## In-repo vs ops boundary

The argument leans on three controls. Two of them live outside this
repository and are owned by whoever operates the paymaster/sponsor:

- **Backend already-used-intent guard (4)** — there is no sponsor or
  paymaster backend in this monorepo (packages are `cli`, `cranker`,
  `sdk`, `webapp`; the sponsor is Fogo Labs' external paymaster reached
  via `/api/sponsor_pubkey`). The hash-dedupe guard and its test must
  land in that service. This document is the requirement.

- **Short intent expiries (5)** — the signed intent message format is
  byte-pinned to the upstream parser (`version: 0.2`, see
  `packages/sdk/src/builders/intent-transfer.ts::buildBridgeOutIntentMessage`)
  and carries **no** expiry/`valid_until` field. Adding one would break
  the audited on-chain `BridgeMessage::TryFrom` parser. Expiry is
  therefore enforced at the **sponsor layer** — the sponsor refuses to
  co-sign an intent older than its window — not in the message. This is
  an ops/infra control, not a webapp change.

- **Replay monitoring (6)** — this one **is** in-repo:
  `cranker_intent_replay_observed_total{leg}` in
  `packages/cranker/src/relayer/replay-monitor.ts`, wired into both
  `claim-usdc.ts` (deposit) and `unlock-onyc.ts` (withdraw). Add a
  Prometheus alert on `increase(cranker_intent_replay_observed_total[1h]) > 0`.
