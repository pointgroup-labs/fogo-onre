# Findings: Wormholescan coverage for FOGO ↔ Solana NTT flows

**Date:** 2026-05-09
**Source:** Live probes against `https://api.wormholescan.io/api/v1`
**Status:** Phase 0 / Task 0.2 complete (per `docs/superpowers/plans/2026-05-09-onchain-transfer-history.md`)

## Executive finding

**Wormholescan fully indexes FOGO (Wormhole chain 51) NTT traffic in both directions, decodes NTT manager messages to field level, and supports per-user filtering via `?address=<userPubkey>`.** This unlocks **Path A** (client-only Wormholescan-driven history) without requiring a custom indexer or relayer-event decoding.

Combined with Task 0.1 finding (`fogo_sender` correlator exists in relayer events), the architectural question collapses to: **ship Path A, optionally enrich with relayer-event middle states later if UX demands it.**

## Endpoints probed

| Endpoint | Result |
|---|---|
| `GET /protocols/stats?chain=51` | Returns `executor_ntt` with 133,543 messages indexed for FOGO. Confirms chain 51 is a first-class indexed chain, not a stub. |
| `GET /operations?sourceChain=51&pageSize=1` | Returns full NTT-decoded operation. Schema documented below. |
| `GET /operations?sourceChain=1&targetChain=51&pageSize=1` | Reverse direction (Solana → FOGO) also indexed. Confirms both deposit-final-leg and withdraw-final-leg are observable. |
| `GET /operations?address=4gAyxVdgh2Z3AtcqEdNMqqzf7tZzr6MA3jmMFKce8Xi2` | `?address=` filter works against user pubkeys. Returns only that user's operations across chains. **This is the critical capability for the history feature.** |

## Operation schema (relevant fields)

A single operation returned by `/operations` contains everything the UI needs:

```jsonc
{
  "id": "51/8192a21f…3bbd40/16328",   // chain/emitter/sequence — stable id
  "sourceChain": {
    "chainId": 51,
    "transaction": { "txHash": "…" }, // origin burn tx on FOGO
    "from": "<user pubkey>",
    "timestamp": "…"
  },
  "targetChain": {
    "chainId": 1,
    "transaction": { "txHash": "…" }, // destination tx on Solana
    "to": "<recipient>",
    "status": "completed" | "pending" | …
  },
  "content": {
    "payload": {
      "nttManagerMessage": { "id": "<32-byte hash>", … },
      "nttMessage": {
        "to": "<recipient pubkey>",
        "toChain": 1,
        "sourceToken": "<USDC.s or ONyc mint>",
        "trimmedAmount": { "amount": "…", "decimals": 6 }
      }
    },
    "standarizedProperties": {
      "fromChain": 51, "fromAddress": "<user>",
      "toChain": 1,    "toAddress": "<recipient>",
      "tokenAddress": "<mint>", "amount": "…"
    }
  }
}
```

Direction (deposit vs withdraw) is derivable from `(fromChain, toChain, tokenAddress)`:
- `fromChain=51, toChain=1, token=USDC.s mint` → deposit (FOGO USDC.s burn → Solana relayer claims)
- `fromChain=1,  toChain=51, token=ONyc mint`  → deposit final leg (Solana ONyc lock → FOGO ONyc mint)
- `fromChain=51, toChain=1, token=ONyc mint`  → withdraw (FOGO ONyc burn → Solana relayer unlocks)
- `fromChain=1,  toChain=51, token=USDC.s mint` → withdraw final leg (Solana USDC release → FOGO USDC.s mint)

## What Wormholescan does *not* give us

1. **Relayer middle states.** Operations correspond to NTT messages, not OnRe redemption-queue states. A withdraw sitting in the OnRe queue between `OnycUnlocked` and `RedemptionRequested` will appear to Wormholescan as "delivered to Solana" — the user-perceived "in queue, may take days" sub-state is invisible here.
2. **`RedemptionCancelled` failure signal.** A cancelled redemption never produces the second NTT op (Solana → FOGO USDC.s). Wormholescan shows only the first op (FOGO ONyc burn) sitting indefinitely. The exact failure reason and `returned_onyc_amount` live only in the relayer event.
3. **Bridge fee detail.** `gross/fee/net` from `OnycSwapped` / `RedemptionRequested` aren't in NTT operations.

These are **enrichment opportunities** for later, not blockers for shipping a useful history feature.

## Path-decision matrix (resolved)

| Capability | Status |
|---|:-:|
| Wormholescan indexes FOGO chain 51 | ✅ |
| Wormholescan decodes NTT messages | ✅ |
| Wormholescan supports `?address=` user filtering | ✅ |
| Relayer events expose `fogo_sender` correlator (Task 0.1) | ✅ |
| Relayer events expose `flow` join key (Task 0.1) | ✅ |
| Relayer events expose `RedemptionCancelled` failure state | ✅ |

**Selected path: A** — Wormholescan client-only, with origin/destination NTT pairing. UI status: `pending` (only origin op seen) | `delivered` (both legs seen). Failure surfaced as "stuck > N days, view on explorer" until/unless we add Path D enrichment.

**Path D (custom relayer-event indexer)** is not on the critical path but remains the best fallback if Wormholescan latency or rate limits prove problematic in production. Defer indefinitely.

**Path B (client-side log scanning)** is downgraded to last-resort fallback. No good reason to ship it given Path A works.

## Operational notes

- Wormholescan is a third-party API. Production use should add: client-side caching by operation `id`, exponential backoff on 429, and a fallback "view on Wormholescan / FOGO explorer" link when the API is unreachable.
- Rate limits and SLAs are not contractually documented on the public endpoint. A server-side proxy with shared cache is recommended before mainnet traffic, but not required for an MVP behind a feature flag.
- The `?address=` filter is most likely an exact-match against `from` / `to` standarized addresses. Confirm against the user's session-key pubkey vs. wallet pubkey before shipping (the standing "session-signer assumption" check from Task 0.3 still applies).

## Recommended next actions

1. Mark Task 0.2 complete in the plan and select Path A.
2. Proceed to Task 0.3 (session-signer validation against `?address=`).
3. Begin Phase 1A scaffolding (`useTransferHistory` hook against `/operations`).
