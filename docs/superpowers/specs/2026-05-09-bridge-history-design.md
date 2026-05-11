# Bridge History — Design Spec (Path B + Wormholescan oracle, unified list)

**Date:** 2026-05-09
**Supersedes:** Path A scaffolding in `docs/superpowers/plans/2026-05-09-onchain-transfer-history.md`
**Phase 0 inputs:**
- `docs/superpowers/specs/2026-05-09-events-correlator-findings.md` (relayer event correlator audit)
- `docs/superpowers/specs/2026-05-09-wormholescan-coverage.md` (Wormholescan coverage probe)
- `docs/superpowers/specs/2026-05-09-session-signer-validation.md` (Wormholescan filter behavior — invalidated Path A)

## Goal

Surface a cross-device, cross-session, cache-resilient view of the user's bridge history (deposits and withdraws) sourced entirely from on-chain data, replacing the existing localStorage-backed `PendingTxList` with one unified list that subsumes both in-flight and historical rows.

## Locked decisions

| # | Decision | Choice |
|---|---|---|
| Q1 | Operational footprint | Zero new infrastructure (client-only) |
| Q2 | Status fidelity | Two-state: `pending` or `delivered`, no middle states, no failure detection |
| Q3 | Pairing strategy | Wormholescan as status oracle + graceful degrade to bare event row |
| Q4 | Coexistence with `PendingTxList` | Replace with one unified list |
| Q5 | Rollout posture | Hard cutover, no feature flag |
| — | Tests in v1 | Skipped — TypeScript + manual QA only |

## Architecture

`BridgeHistory` is a single React component fed by one hook, `useBridgeHistory(owner)`. The hook merges three independent read-only sources:

1. **FOGO RPC enumeration (the enumerator).** `getSignaturesForAddress` paginated against the user's two canonical FOGO ATAs (USDC.s and ONyc), filtered to bridge-relevant txs by program-allowlist, with direction inferred from pre/post token-balance delta. Only this source produces rows. Cross-session and cross-device coverage is keyed on the user's stable wallet (the canonical ATA is wallet-derived, not session-key-derived).
2. **Wormholescan status oracle (the status enricher).** For each enumerated burn signature, one `GET /operations?txHash=<sig>` call. Annotates the row with `delivered` / `pending` / `unknown`. Never produces rows.
3. **Local in-flight journal (the phase enricher).** Existing journal that today drives `PendingTxList`. Read via TanStack Query cache (`['flow-status', signature]`). For bridges initiated from this session, supplies a granular phase pill that overrides the basic `pending` badge.

```
ATA signatures (RPC)  ──► filter ──► extract delta ──► event rows
                                                         │
                  Wormholescan op (per row, optional) ───┼──► status badge
                                                         │
                  Local journal (per row, optional) ─────┴──► phase override
                                                         │
                                                         ▼
                                                   merged TimelineRow[]
                                                   sorted desc by blockTime
```

## File structure

```
packages/webapp/src/lib/bridgeHistory/
  rpc.ts             # enumerate canonical ATAs, filter, extract burn rows
  wormholescan.ts    # txHash → operation status (single fetch)
  merge.ts           # RPC rows × Wormholescan op × journal entry → TimelineRow
  types.ts           # TimelineRow, BurnRow, OperationStatus

packages/webapp/src/hooks/
  useBridgeHistory.ts

packages/webapp/src/components/
  BridgeHistory.tsx
```

**Modified:** `packages/webapp/src/app/page.tsx` — `<PendingTxList />` replaced with `<BridgeHistory />`.

**Deleted:** `packages/webapp/src/components/PendingTxList.tsx` (and its test if present).

**Untouched but consumed:** the journal module and `useFlowStatus`. The journal contract is preserved; only its UI consumer changes.

## Row model

The unit-of-rendering is **one row per user-initiated bridge intent**, keyed on the FOGO `transfer_burn` tx signature. Receives are not their own rows — they're used as corroborating evidence that a flow delivered. This works because in OnRe's bridge UX every user-owned flow starts with a FOGO burn signed by the user (no inbound-only case).

```typescript
type TimelineRow = {
  signature: string                                  // tx sig of the FOGO burn — primary key
  kind: 'deposit' | 'withdraw'
  amountRaw: bigint
  blockTime: number
  status: 'pending' | 'delivered' | 'unknown'
  destinationSignature: string | null
  phase: string | null                               // from local journal, when available
}
```

## Data sources — implementation detail

### RPC enumeration (`lib/bridgeHistory/rpc.ts`)

Resolves both canonical ATAs:

```
usdcSAta = getAssociatedTokenAddress(USDC_S_MINT, owner)
onycAta  = getAssociatedTokenAddress(FOGO_ONYC_MINT, owner)
```

Per ATA: `getSignaturesForAddress(ata, { limit: 50, before: cursor, commitment: 'finalized' })`. Per signature: `getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'finalized' })`. A row is kept iff:

- `tx.err === null` (failed bridges excluded)
- `accountKeys ∩ ALLOWLIST ≠ ∅` where `ALLOWLIST = { USDC_NTT_MANAGER, ONYC_NTT_MANAGER, RELAYER_PROGRAM_ID }`
- The pre/post token-balance delta on this ATA is **negative** (a burn — positive deltas are receives, used only as fulfillment evidence in `merge.ts`)

Output: `BurnRow { signature, ata, mint, amountRaw, blockTime, slot }`. Both ATAs' streams merged in the hook, sorted desc by `blockTime`, deduped by signature.

### Wormholescan status oracle (`lib/bridgeHistory/wormholescan.ts`)

```
GET https://api.wormholescan.io/api/v1/operations?txHash=<signature>
```

Three outcomes:

- Operation found, `targetChain.transaction.txHash` present → `{ kind: 'delivered', destinationTxHash }`
- Operation found, no destination tx yet → `{ kind: 'pending' }`
- Not found / fetch error / 3s timeout (`AbortSignal.timeout(3000)`) → `{ kind: 'unknown' }` (graceful degrade to bare event row)

Response decoded with a runtime schema (zod or lightweight hand-rolled) — schema drift downgrades to `unknown` rather than throwing.

### Local journal

Read-only access via `queryClient.getQueryData(['flow-status', signature])`. The journal is never written from `merge.ts`; the live tracker (`useFlowStatus`) remains the sole writer. When a flow goes terminal, the live tracker evicts it from the journal as today; the row continues to exist in `BridgeHistory` because RPC + Wormholescan can still reconstruct it.

### Merge function (`lib/bridgeHistory/merge.ts`)

```typescript
function mergeRow(burn: BurnRow, op: OperationStatus | null, journal: JournalEntry | null): TimelineRow {
  return {
    signature: burn.signature,
    kind: burn.mint === USDC_S_MINT ? 'deposit' : 'withdraw',
    amountRaw: burn.amountRaw,
    blockTime: burn.blockTime,
    status: op?.kind ?? 'unknown',
    destinationSignature: op?.destinationTxHash ?? null,
    phase: journal?.phase ?? null,
  }
}
```

Pure function; deterministic. Easy to test later if needed.

## Caching and RPC budget

### Cost envelope (50-row page)

```
Initial cold load:   2 × getSignaturesForAddress  +  ≤50 × getTransaction  +  ≤50 × Wormholescan op
                   = up to ~152 calls
Steady state warm:   2 × getSignaturesForAddress  +  N × Wormholescan op (N = pending rows only)
                   = ~5 calls per refresh
```

### TanStack Query strategy

| Cache key | `staleTime` | `gcTime` | Refetch on focus |
|---|---|---|---|
| `['ata-sigs', ata, beforeCursor]` (head, `before === undefined`) | 30s | 24h | yes |
| `['ata-sigs', ata, beforeCursor]` (cursored) | `Infinity` | 24h | no |
| `['tx-finalized', signature]` | `Infinity` | `Infinity` | no |
| `['wormholescan-op', signature]` (`delivered`) | `Infinity` | `Infinity` | no |
| `['wormholescan-op', signature]` (`pending`) | 30s | 24h | yes |
| `['wormholescan-op', signature]` (`unknown`) | 10s | 1h | yes (backoff: 1s, 3s, 9s, give up) |
| `['flow-status', signature]` | (existing — managed by live tracker) | (existing) | (existing) |

The webapp already uses TanStack Query with persistence via `PersistQueryClientProvider` (`packages/webapp/src/lib/query/persist.tsx`); new cache keys plug into the existing persisted store automatically. `BridgeHistory` should gate its first render on `useIsRestoring()` the same way `PendingTxList` does today, so cached rows render before any network call.

### Failure modes

| Failure | Behavior |
|---|---|
| RPC throttled / down | TanStack retries with backoff; UI shows skeleton, then last-cached page if any with a small "stale" banner, otherwise an `Alert` |
| Wormholescan down | Per-row falls through to `status: 'unknown'`; rest of the list still renders |
| Both down on cold load (no cache) | Empty-state Alert: "Couldn't load history. Try again." |

## UI

### Layout

`BridgeHistory` mounts in the same slot `PendingTxList` occupies today (`packages/webapp/src/app/page.tsx`). Outer container: shadcn `Card`. Heading: "Bridges."

### Row shape

```
[direction icon]  Deposit · 100.00 USDC.s     [status badge]  [explorer ↗]
                  May 5, 2026 · 14:23
```

| Field | Source |
|---|---|
| direction icon | `kind` — `↗` deposit, `↘` withdraw |
| label | `kind` + `mint` + `amountRaw` |
| timestamp | `blockTime`, localized |
| status badge | `phase ?? status` (precedence below) |
| explorer link | `signature`; `destinationSignature` when present (second link) |

### Status badge precedence

One source of truth, first non-null wins:

1. `row.phase` (granular journal pill — only when this device + this session originated the bridge and it's still in-flight)
2. `row.status === 'pending'` → `Bridging…` (`secondary` variant)
3. `row.status === 'delivered'` → `Delivered` (`default` variant)
4. `row.status === 'unknown'` → no badge (graceful degrade)

### State table

| State | UI |
|---|---|
| `owner === null` | component returns `null` |
| Loading first page | 3× shadcn `Skeleton` rows |
| Error, no cache | `Alert` "Bridge history unavailable. Try again." + retry button |
| Empty | "No bridges yet. Your bridge history will appear here." |
| Page loaded, more available | "Load more" `<button>` at bottom |
| Loading subsequent pages | inline spinner on the "Load more" button |

### Affordances out of scope for v1

Filters, search, date range, CSV export, row expansion, virtualized lists, infinite scroll. Bare row + explorer link is the entire interaction surface.

### Accessibility

- `<ul aria-label="Bridge history">` containing `<li>` rows.
- Status badge has `aria-label` with the full phrase ("status: bridging" / "status: delivered").
- Explorer links use `rel="noreferrer noopener"` and visible text.
- "Load more" is a real `<button>`.

## Documented constraints

1. **Archival FOGO RPC required.** `getSignaturesForAddress` against an ATA returns unbounded history only on archival nodes. If the configured RPC prunes signature history, "history" silently caps at the prune horizon. **Deployment-time concern**, not a code concern; add a one-line note to `docs/deploy-mainnet.md` flagging the archival requirement, and verify pre-prod by paging an ATA back >7 days.
2. **Finalized commitment** for cache promotion. Confirmed-but-not-finalized rows can reorg.
3. **Canonical ATA only.** Auxiliary token accounts and Token-2022 variants out of scope.
4. **Failed burns excluded** (filter requires `tx.err === null`).
5. **No status synthesis beyond `delivered`/`pending`/`unknown`.** UI shows facts; user infers state.
6. **No `failed` state.** Stuck flows render as `pending` with the explorer link as the only diagnostic.
7. **Wormholescan is third-party.** No SLA. Graceful-degrade to `unknown` is the only mitigation in v1; a server-side proxy with shared cache is the future hardening path.

## Out of scope (explicit deferrals)

1. Solana-side middle states (`OnycSwapped`, `RedemptionRequested`, `RedemptionCancelled`, `RedemptionClaimed`).
2. Failure detection on stuck/cancelled bridges.
3. Bridge-fee detail per row.
4. Filters / search / date range / CSV export.
5. Token-2022 and auxiliary ATAs.
6. Pagination beyond "Load more" (no virtualization, no infinite scroll).
7. Cross-chain Solana-side history.
8. Custom indexer (Path D — deferred until UX evidence justifies operational cost).
9. Automated test coverage on this surface — deferrable follow-up if regressions show up.

## Risks (prioritized)

| # | Risk | Mitigation |
|---|---|---|
| 1 | RPC throttle on `getTransaction` bursts during cold load | Aggressive cache (`staleTime: Infinity` for finalized txs); recommend paid RPC for production |
| 2 | Configured RPC is not archival → silent history truncation | Document requirement in setup readme; verify in pre-prod |
| 3 | Wormholescan rate limits or downtime | Per-row degrade to `unknown`; future server-side proxy |
| 4 | Schema drift in Wormholescan response | Runtime schema validation; degrade to `unknown` on parse failure |
| 5 | NTT manager program upgrade changes account-key set | Allowlist by program ID (stable across upgrades) |
| 6 | `getTransaction` returns null for pruned ledger entries | Render degraded "view on explorer" row (the row's signature + minimal data from the signature index) |

## Migration path

This is a hard cutover (Q5). The PR sequence:

1. Add new files (`lib/bridgeHistory/*`, `hooks/useBridgeHistory.ts`, `components/BridgeHistory.tsx`).
2. Modify `packages/webapp/src/app/page.tsx`: `<PendingTxList />` → `<BridgeHistory />`.
3. Delete `packages/webapp/src/components/PendingTxList.tsx`.

Single commit or a tight sequence; no feature flag. Rollback = `git revert`.

## Definition of done

- All five new files exist and TypeScript-compile clean under strict mode.
- ESLint passes.
- `BridgeHistory` mounted on the main page; `PendingTxList` deleted from disk and from `page.tsx`.
- Manual QA in staging passes:
  1. Wallet with prior delivered bridge → row renders with `Delivered` and a working destination link.
  2. Wallet with in-flight bridge initiated this session → row renders with the journal phase pill, transitions to `Delivered` after the cranker completes.
- Archival RPC requirement documented in the setup readme.
- Rollback documented (one-line: `git revert <sha>`).
