# Findings: Wormholescan `?address=` filter behavior under Fogo Sessions

**Date:** 2026-05-09
**Source:** Live probes against `https://api.wormholescan.io/api/v1/operations`
**Status:** Phase 0 / Task 0.3 complete — **Path A invalidated; Path D promoted to primary.**

## Executive finding

**Wormholescan's `?address=` filter matches against `sourceChain.from` (the on-chain signer of the FOGO `transfer_burn` tx), not against the user-stable identity embedded in the NTT message (`standarizedProperties.fromAddress` / `nttManagerMessage.sender`).** Under Fogo Sessions — the dominant UX in this webapp — the signer is an ephemeral session key that rotates. There is **no Wormholescan query** that retrieves a user's full cross-session bridge history keyed on their wallet pubkey.

This invalidates Path A as the primary implementation. The clean path forward is Path D (custom relayer-event indexer), which can key on `fogo_sender` from the relayer's events.

## Probe results

### Probe 1: address fields in a single op

For one FOGO→Solana NTT op, we observed four candidate "from"-shaped fields:

| Field | Value (op #1) | Value (op #2) | Stable per user? |
|---|---|---|---|
| `sourceChain.from` | `4gAyxVdgh…8Xi2` | `47aX6RNhQR…M4X` | ❌ — rotates with session key |
| `standarizedProperties.fromAddress` | `4gAyxVdgh…8Xi2` | `EkYeW6iAtp…5vBL` | ✅ — the user's wallet |
| `standarizedProperties.toAddress` | `4gAyxVdgh…8Xi2` | varies per op | ✅ (per-op recipient) |
| `content.payload.nttManagerMessage.sender` (hex) | base58→ `4gAyxVdgh…8Xi2` | base58→ `EkYeW6iAtp…5vBL` | ✅ — same as `std.fromAddress` |

In op #1, all four collapse to one pubkey (a self-signed user, no Sessions paymaster). In op #2 (and 9/10 others sampled), `sourceChain.from` differs from `std.fromAddress`/`nttManagerMessage.sender` — characteristic of **Fogo Sessions ephemeral signing**.

### Probe 2: filter behavior

| Query | Result | Interpretation |
|---|---|---|
| `?address=<userWallet>` (`EkYeW6iA…`) | **0 ops** | Filter does not match `std.fromAddress`. |
| `?address=<sessionSigner>` (`47aX6RNh…`) | 5+ ops, all with `std.from = EkYeW6iA…` | Filter matches `sourceChain.from`. |
| `?fromAddress=<userWallet>` | Returns ops, but **none** have matching `std.fromAddress` | **Parameter silently ignored.** |
| `?fromAddress=<invalid>` | Returns same baseline ops | Confirms ignore. |
| `?sender=<userWallet>` | Same | Also ignored. |

**Hard conclusion:** the only operative filter is `?address=`, and it scopes to `sourceChain.from` — the session signer, not the user wallet.

### Probe 3: session-key cohesion

Across 50 ops signed by `47aX6RNh…`, all 50 had `std.fromAddress = EkYeW6iAtp…` (1 distinct value). This is consistent with `47aX6RNh…` being **one user's session ephemeral key**, not a shared paymaster across many users. So the `?address=<sessionKey>` filter *would* return that user's bridges — but only those signed by *that* session.

## Why this kills Path A

Fogo Sessions rotates the session ephemeral key periodically (and on logout/relogin). A user with bridges across N sessions has N distinct `sourceChain.from` values, none of which is their wallet pubkey. To reconstruct their full history via Wormholescan we would need to:

1. Enumerate all session keys that key has ever used (no on-chain primitive for this — would need backend session-registry lookup), **or**
2. Fetch all FOGO operations (133K+ and growing) and client-side filter by `std.fromAddress` (unbounded RPC cost; not feasible).

Neither is acceptable for a webapp client. **Path A as written cannot serve the cross-session, cross-device history requirement that motivated this work in the first place** (per `docs/superpowers/specs/2026-05-09-onchain-transfer-history-design.md` premise).

## Path-decision update (supersedes Task 0.4)

| Path | Primary correlator | Cross-session? | Cross-device? | Cost |
|---|---|:-:|:-:|---|
| ~~**A** — Wormholescan `?address=<wallet>`~~ | `sourceChain.from` | ❌ | ❌ | invalidated |
| **A\*** — Wormholescan `?address=<currentSessionKey>` | `sourceChain.from` | ❌ (this session only) | ⚠️ (only if session is shared) | low |
| **D** — Custom relayer-event indexer keyed on `fogo_sender` | relayer event correlator | ✅ | ✅ | 2–3 days |
| **B** — Client-side log scan (`getSignaturesForAddress` per ATA) | ATA tx history | depends on archival RPC | ✅ | high RPC cost, slow |

**Recommended path: D.** Build a small relayer-event indexer (websocket → decode events → Postgres → REST) that keys rows on `fogo_sender` (Task 0.1 confirmed this is `[u8; 32]` of the user's FOGO wallet pubkey) and `flow` (joins all 8 events of a single bridge). `GET /api/history?owner=<userWallet>` returns the user's complete cross-session history.

Path B remains the fallback if hosting an indexer is not acceptable; it has its own session-signer pitfalls but enumerating against the **user's canonical ATA** (deterministic from wallet+mint, not the session signer) sidesteps them — as long as the FOGO `transfer_burn` tx surfaces the ATA in `accountKeys`, which is plausible but not yet validated. That validation moves into Phase 0 of any Path B sub-plan.

## Implications for the plan

The current plan (`docs/superpowers/plans/2026-05-09-onchain-transfer-history.md`) prepared scaffolding for Path A as primary. With Path A invalidated:

1. **Phase 1A (Wormholescan client + hook + UI) should be removed or relabeled as Path A\*** — useful only as a "current-session bridge tracker" enrichment if we ever need it, not as the history feature.
2. **Phase 1D (relayer-event indexer) needs to be added** as the new primary phase. Will require:
   - Backend service (websocket subscriber + decoder + Postgres + REST API)
   - Deployment infrastructure (the webapp is currently client-only)
   - SDK addition for the new endpoint
   - Schema versioning (Anchor IDL is the source of truth)
3. **Path B sub-plan** as documented fallback if hosting an indexer is rejected.

Given the operational lift of standing up a backend, this should go through brainstorming again before re-planning — the architectural shape ("client-only Wormholescan" vs "backend indexer") is a different commitment than what was originally scoped.

## Recommended next actions

1. Hold Phase 1 implementation. Don't scaffold a hook against Wormholescan that can't filter for the right address.
2. Brainstorm the Path D architecture: where the indexer lives, how it's deployed, whether to use a managed indexer service (Helius webhooks, Triton enhanced) instead of self-hosting.
3. Once Path D shape is agreed, write a fresh plan superseding this one.
