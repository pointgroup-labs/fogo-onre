# On-Chain Transfer History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a cross-device, cache-resilient view of the user's deposit and withdraw history sourced from on-chain data, without modifying the existing in-flight `PendingTxList` UX.

**Architecture:** Phase 0 validates open assumptions (Wormholescan FOGO support, presence of an on-chain correlator in `events.rs`, session-signer enumeration). Phase 1 selects between two paths based on Phase 0 outcome: (A) Wormholescan-backed `useTransferHistory` with flow-centric rows, or (B) event-list "Activity" view if Wormholescan does not cover FOGO. New `AllTransfers` section is additive, feature-flagged, leaves the live tracker / journal / `PendingTxList` untouched.

**Tech Stack:** TypeScript, Next.js (webapp), `@tanstack/react-query`, `@solana/web3.js` (existing), shadcn/ui (existing). For Path A: `fetch` against Wormholescan REST. For Path B: `getSignaturesForAddress` + `getTransaction` against archival FOGO RPC.

---

## Phase 0 status (2026-05-09)

- **Task 0.1 — events.rs correlator audit:** ✅ complete. Findings: `docs/superpowers/specs/2026-05-09-events-correlator-findings.md`. `fogo_sender: [u8; 32]` is a user-derivable correlator emitted on flow-boundary events; `flow: Pubkey` joins all 8 events of a flow; `RedemptionCancelled` exposes an exact failure signal.
- **Task 0.2 — Wormholescan coverage probe:** ✅ complete. Findings: `docs/superpowers/specs/2026-05-09-wormholescan-coverage.md`. FOGO chain 51 indexed (133,543 NTT messages), full NTT message decode, both directions covered. **Caveat surfaced in Task 0.3 below: per-user filtering does not work for Sessions users.**
- **Task 0.3 — session-signer / address-filter validation:** ✅ complete. Findings: `docs/superpowers/specs/2026-05-09-session-signer-validation.md`. **`?address=` matches `sourceChain.from` (session signer), not `standarizedProperties.fromAddress` (user wallet). `?fromAddress=` and `?sender=` are silently ignored. There is no Wormholescan filter that retrieves a user's cross-session history.**
- **Task 0.4 — path selection:** ✅ complete. **Path A invalidated. Recommended path: D (custom relayer-event indexer). Path A\* (current-session-only) and Path B (RPC log-scan) remain as fallbacks.**

Updated path-decision matrix:

| Path | Correlator | Cross-session? | Cross-device? | Status |
|---|---|:-:|:-:|---|
| ~~A — Wormholescan `?address=<wallet>`~~ | `sourceChain.from` | ❌ | ❌ | **invalidated by Task 0.3** |
| A\* — Wormholescan `?address=<currentSessionKey>` | `sourceChain.from` | ❌ | ⚠️ | enrichment only, not history |
| **D — Custom relayer-event indexer (`fogo_sender`)** | relayer event | ✅ | ✅ | **selected** — needs new plan |
| B — Client-side log scan per canonical ATA | ATA tx history | depends on archival RPC | ✅ | fallback if Path D infra rejected |

**This plan is now stale.** Phase 1A scaffolds against an API filter that doesn't work for Fogo Sessions users. Halt before scaffolding; brainstorm Path D shape (self-hosted indexer vs Helius webhooks vs Triton enhanced API) and write a fresh plan superseding this one.

---

## Phase 0 — Validation gate (no implementation until complete)

Phase 0 produces three written findings. Phase 1 path selection depends on the outcomes. **Do not begin Phase 1 until Phase 0 is signed off.**

### Task 0.1: Inspect `events.rs` for an on-chain correlator

**Files:**
- Read: `programs/relayer/src/events.rs`
- Read: `programs/relayer/src/instructions/*.rs` (any file containing `emit!`)
- Write: `docs/superpowers/specs/2026-05-09-events-correlator-findings.md`

- [x] **Step 1: Enumerate every `emit!` site**

Run: `rg -n 'emit!' programs/relayer/src/`
Document each event struct: name, fields, which instruction emits it.

- [x] **Step 2: Identify whether any event carries a user-derivable correlator**

For each event, mark whether it contains:
- The user's `recipient` or `owner` pubkey
- A `flow_id` / message hash / VAA sequence
- The originating FOGO `transfer_burn` signature (will be absent — Solana txs cannot reference foreign-chain signatures, but check anyway)

- [x] **Step 3: Write findings**

Write `docs/superpowers/specs/2026-05-09-events-correlator-findings.md` with:
- Event inventory (table)
- Correlator presence (yes/no per event)
- Conclusion: "correlator exists and is queryable client-side / correlator exists but requires log-scan / no correlator exists"

- [ ] ~~**Step 4: Commit findings**~~ (skipped per "do not commit" instruction)

```bash
git add docs/superpowers/specs/2026-05-09-events-correlator-findings.md
git commit -m "docs: events.rs correlator audit for history feature"
```

### Task 0.2: Validate Wormholescan FOGO + NTT coverage

**Files:**
- Write: `docs/superpowers/specs/2026-05-09-wormholescan-coverage.md`

- [x] **Step 1: Identify Wormholescan API base URL and auth requirements**

Run: `curl -sS https://api.wormholescan.io/api/v1/health` (or current public endpoint).
Document base URL, rate limits, auth header (if any).

- [x] **Step 2: Confirm FOGO chain ID is recognized**

Wormhole assigns FOGO a chain ID (referenced in `programs/relayer/src/constants.rs::FOGO_WORMHOLE_CHAIN_ID`). Use that chain ID against:
`GET /api/v1/operations?sourceChain=<FOGO_CHAIN_ID>&address=<known_test_wallet>`

If FOGO is unsupported, the API returns an error or empty result. Document the response shape.

- [x] **Step 3: Confirm NTT manager addresses are indexed**

Query for operations where `emitterAddress` matches the USDC.s NTT manager (`nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk`) or ONyc NTT manager (`nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd`). Verify the response includes amount, recipient, status fields.

- [x] **Step 4: Test per-user filtering**

Use a known-prior burn signature from a developer wallet. Confirm the wallet appears in Wormholescan's response when filtered by `address`. Document the exact request shape that works.

- [x] **Step 5: Write findings**

Write `docs/superpowers/specs/2026-05-09-wormholescan-coverage.md` with:
- API base URL + auth
- FOGO chain ID accepted: yes/no
- NTT managers indexed: yes/no, with sample response
- Per-user filtering supported: yes/no, with exact query shape
- Conclusion: "Wormholescan is viable / partial / not viable"

- [ ] ~~**Step 6: Commit findings**~~ (skipped per "do not commit" instruction)

```bash
git add docs/superpowers/specs/2026-05-09-wormholescan-coverage.md
git commit -m "docs: wormholescan FOGO+NTT coverage audit"
```

### Task 0.3: Validate session-signer enumeration assumption

**Files:**
- Write: `docs/superpowers/specs/2026-05-09-session-signer-validation.md`

- [ ] **Step 1: Pick a known prior FOGO burn tx**

Use the developer wallet's localStorage journal or transaction history. Record:
- `userWalletPubkey` (the established session's wallet pubkey)
- `userUsdcSAtaPubkey` (derived from `getATA(USDC_S_MINT, userWalletPubkey)`)
- A known prior `transfer_burn` signature

- [ ] **Step 2: Probe `getSignaturesForAddress` against FOGO RPC**

Run a script (or paste into browser devtools against a connected webapp instance):
```js
// One-shot validation, not committed code
const sigs1 = await connection.getSignaturesForAddress(userWalletPubkey, { limit: 100 })
const sigs2 = await connection.getSignaturesForAddress(userUsdcSAtaPubkey, { limit: 100 })
console.log('wallet hits:', sigs1.find(s => s.signature === knownBurnSig))
console.log('ata hits:', sigs2.find(s => s.signature === knownBurnSig))
```

- [ ] **Step 3: Repeat for ONyc ATA (withdraw side)**

Same shape, with ONyc ATA + a known withdraw burn signature.

- [ ] **Step 4: Write findings**

Write `docs/superpowers/specs/2026-05-09-session-signer-validation.md` with:
- Wallet-pubkey enumeration: hits/misses
- ATA enumeration: hits/misses
- Conclusion: "enumerate by ATA / enumerate by wallet / both work / neither works"

If neither works → Path B is dead in the water; only Path A (Wormholescan) or a custom indexer is viable.

- [ ] **Step 5: Commit findings**

```bash
git add docs/superpowers/specs/2026-05-09-session-signer-validation.md
git commit -m "docs: session-signer enumeration validation"
```

### Task 0.4: Phase 0 sign-off and path selection

**Files:**
- Write: `docs/superpowers/specs/2026-05-09-history-path-decision.md`

- [ ] **Step 1: Cross-reference all three findings**

| Wormholescan covers FOGO+NTT | events.rs has correlator | session-signer ATA works | Recommended path |
|---|---|---|---|
| Yes | (any) | (any) | **Path A — Wormholescan** |
| No | Yes | Yes | **Path B — event-list with relayer-event correlator** |
| No | No | Yes | **Path B — event-list, no synthesis** ("Activity" framing) |
| No | (any) | No | **Stop. Custom indexer required (separate plan).** |

- [ ] **Step 2: Write decision document**

Write `docs/superpowers/specs/2026-05-09-history-path-decision.md` with:
- Findings summary (one paragraph per Phase 0 task)
- Path selected
- Rationale
- Out-of-scope items deferred

- [ ] **Step 3: Commit decision and proceed to Phase 1 of the matching path**

```bash
git add docs/superpowers/specs/2026-05-09-history-path-decision.md
git commit -m "docs: select on-chain history implementation path"
```

---

## Phase 1A — Wormholescan-backed flow-centric history

> **⚠️ DO NOT IMPLEMENT.** Task 0.3 (2026-05-09) discovered that `?address=` filters against the session signer, not the user wallet. Under Fogo Sessions this returns either nothing (filtering by wallet) or this-session-only history (filtering by current session key). See `docs/superpowers/specs/2026-05-09-session-signer-validation.md`. The tasks below are preserved for reference only — they may be revived as **Path A\*** (current-session enrichment) once Path D ships.

**Skip this phase.**

### Task 1A.1: Wormholescan client module

**Files:**
- Create: `packages/webapp/src/lib/wormholescan/client.ts`
- Test: `packages/webapp/src/lib/wormholescan/client.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/webapp/src/lib/wormholescan/client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { fetchUserOperations } from './client'

describe('wormholescan client', () => {
  it('fetches operations for a wallet, mapping to TransferRow shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        operations: [
          {
            sourceChain: { chainId: 32 /* FOGO */, transaction: { txHash: 'abc' }, from: 'WALLET', timestamp: '2026-05-08T12:00:00Z' },
            targetChain: { chainId: 32, transaction: { txHash: 'def' }, status: 'completed' },
            content: { payload: { amount: '1000000', tokenAddress: 'USDC_S_MINT' } },
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const rows = await fetchUserOperations({ owner: 'WALLET', limit: 25 })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'deposit', status: 'delivered', amountRaw: 1_000_000n })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm webapp test packages/webapp/src/lib/wormholescan/client.test.ts`
Expected: FAIL with "Cannot find module './client'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/webapp/src/lib/wormholescan/client.ts
import { FOGO_WORMHOLE_CHAIN_ID, USDC_S_MINT, FOGO_ONYC_MINT } from '@/constants'

export interface TransferRow {
  signature: string
  kind: 'deposit' | 'withdraw'
  amountRaw: bigint
  blockTime: number
  status: 'pending' | 'delivered'
  destinationSignature: string | null
}

export async function fetchUserOperations(args: {
  owner: string
  limit?: number
  cursor?: string
}): Promise<TransferRow[]> {
  const url = new URL('https://api.wormholescan.io/api/v1/operations')
  url.searchParams.set('address', args.owner)
  url.searchParams.set('sourceChain', String(FOGO_WORMHOLE_CHAIN_ID))
  if (args.limit) url.searchParams.set('pageSize', String(args.limit))
  if (args.cursor) url.searchParams.set('page', args.cursor)
  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`wormholescan: HTTP ${res.status}`)
  const body = await res.json()
  return (body.operations ?? []).map(mapOperation)
}

function mapOperation(op: any): TransferRow {
  const tokenMint = op.content?.payload?.tokenAddress
  const kind = tokenMint === USDC_S_MINT.toBase58() ? 'deposit' : 'withdraw'
  return {
    signature: op.sourceChain.transaction.txHash,
    kind,
    amountRaw: BigInt(op.content?.payload?.amount ?? 0),
    blockTime: Math.floor(new Date(op.sourceChain.timestamp).getTime() / 1000),
    status: op.targetChain?.status === 'completed' ? 'delivered' : 'pending',
    destinationSignature: op.targetChain?.transaction?.txHash ?? null,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm webapp test packages/webapp/src/lib/wormholescan/client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/lib/wormholescan/client.ts packages/webapp/src/lib/wormholescan/client.test.ts
git commit -m "feat(webapp): wormholescan client for user operations"
```

### Task 1A.2: `useTransferHistory` hook

**Files:**
- Create: `packages/webapp/src/hooks/useTransferHistory.ts`
- Test: `packages/webapp/src/hooks/useTransferHistory.test.tsx`

- [ ] **Step 1: Write the failing test**

```typescript
// Test that the hook returns rows from the client, sorted desc by blockTime,
// caches infinitely for delivered rows, refetches first page on focus.
// (Full test body — render hook with QueryClient wrapper, mock fetchUserOperations,
// assert ordering + cache behavior.)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm webapp test packages/webapp/src/hooks/useTransferHistory.test.tsx`
Expected: FAIL with "Cannot find module './useTransferHistory'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/webapp/src/hooks/useTransferHistory.ts
import { useInfiniteQuery } from '@tanstack/react-query'
import { fetchUserOperations, type TransferRow } from '@/lib/wormholescan/client'
import type { PublicKey } from '@solana/web3.js'

export function useTransferHistory(owner: PublicKey | null) {
  return useInfiniteQuery({
    queryKey: ['transfer-history', owner?.toBase58() ?? null],
    queryFn: async ({ pageParam }) =>
      owner ? fetchUserOperations({ owner: owner.toBase58(), limit: 25, cursor: pageParam }) : [],
    enabled: !!owner,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, allPages) => lastPage.length < 25 ? undefined : String(allPages.length),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm webapp test packages/webapp/src/hooks/useTransferHistory.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/hooks/useTransferHistory.ts packages/webapp/src/hooks/useTransferHistory.test.tsx
git commit -m "feat(webapp): useTransferHistory hook backed by wormholescan"
```

### Task 1A.3: `AllTransfers` UI section

**Files:**
- Create: `packages/webapp/src/components/AllTransfers.tsx`
- Modify: `packages/webapp/src/app/page.tsx` (mount the section)
- Test: `packages/webapp/src/components/AllTransfers.test.tsx`

- [ ] **Step 1: Write the failing test**

Test renders rows from `useTransferHistory`, shows status badges, links to FOGO explorer for both source and destination signatures.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL with "Cannot find module './AllTransfers'"

- [ ] **Step 3: Write minimal implementation**

```tsx
// packages/webapp/src/components/AllTransfers.tsx
'use client'
import { isEstablished, useSession } from '@fogo/sessions-sdk-react'
import { useTransferHistory } from '@/hooks/useTransferHistory'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { fogoTxUrl } from '@/utils/explorers'
import { formatAmount } from '@/utils/transfer'
import { USDC_DECIMALS, FOGO_ONYC_DECIMALS } from '@/constants'

export default function AllTransfers() {
  const session = useSession()
  const owner = isEstablished(session) ? session.walletPublicKey : null
  const { data, isLoading, isError, hasNextPage, fetchNextPage } = useTransferHistory(owner)

  if (!owner) return null
  if (isLoading) return <Skeleton className="h-24" />
  if (isError) return <Alert><AlertTitle>History unavailable</AlertTitle><AlertDescription>Could not fetch transfer history. Try again later.</AlertDescription></Alert>

  const rows = (data?.pages ?? []).flat()
  if (rows.length === 0) {
    return <Alert><AlertTitle>No transfers yet</AlertTitle><AlertDescription>Your bridge history will appear here.</AlertDescription></Alert>
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map(row => (
        <Card key={row.signature}>
          <CardContent className="p-3 flex items-center justify-between text-sm">
            <span>{row.kind === 'deposit' ? 'Deposit' : 'Withdraw'} {formatAmount(row.amountRaw, row.kind === 'deposit' ? USDC_DECIMALS : FOGO_ONYC_DECIMALS)}</span>
            <div className="flex items-center gap-2">
              <Badge variant={row.status === 'delivered' ? 'default' : 'secondary'}>{row.status}</Badge>
              <a href={fogoTxUrl(row.signature)} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline">source</a>
              {row.destinationSignature && <a href={fogoTxUrl(row.destinationSignature)} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline">dest</a>}
            </div>
          </CardContent>
        </Card>
      ))}
      {hasNextPage && <button onClick={() => fetchNextPage()} className="text-xs text-muted-foreground hover:underline">Load more</button>}
    </div>
  )
}
```

- [ ] **Step 4: Mount in `page.tsx` behind a feature flag**

Add `<AllTransfers />` below `<PendingTxList />` gated on `process.env.NEXT_PUBLIC_HISTORY_ENABLED === 'true'`.

- [ ] **Step 5: Run tests to verify they pass**

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/webapp/src/components/AllTransfers.tsx packages/webapp/src/components/AllTransfers.test.tsx packages/webapp/src/app/page.tsx
git commit -m "feat(webapp): AllTransfers section behind feature flag"
```

### Task 1A.4: Local journal reconciliation

**Files:**
- Modify: `packages/webapp/src/components/AllTransfers.tsx`
- Test: extend `AllTransfers.test.tsx`

- [ ] **Step 1: Write the failing test**

When local journal has an in-flight row whose signature matches a Wormholescan `pending` row, render with the journal's granular phase pill instead of the bare `pending` badge.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current component ignores the journal.

- [ ] **Step 3: Implement merge**

Read `['flow-status', signature]` cache entries; for any `pending` row with a matching journal entry, override the badge with the journal's `phase` label.

- [ ] **Step 4: Run tests to verify they pass**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/components/AllTransfers.tsx packages/webapp/src/components/AllTransfers.test.tsx
git commit -m "feat(webapp): merge live journal phase into history rows"
```

### Task 1A.5: Feature flag rollout + production validation

- [ ] **Step 1: Set `NEXT_PUBLIC_HISTORY_ENABLED=true` in staging**
- [ ] **Step 2: Manual QA: connect a wallet with known prior bridges; verify rows render correctly**
- [ ] **Step 3: Verify Wormholescan rate limits are not hit under realistic page-load patterns**
- [ ] **Step 4: Enable in production**
- [ ] **Step 5: Document rollback procedure**

```bash
git commit --allow-empty -m "chore(webapp): enable transfer history in production"
```

---

## Phase 1B — Event-list "Activity" view (fallback path)

**Skip this phase if Path A was selected.**

### Task 1B.1: `isBridgeTx` filter predicate

**Files:**
- Create: `packages/webapp/src/lib/history/filter.ts`
- Test: `packages/webapp/src/lib/history/filter.test.ts`

- [ ] **Step 1: Write the failing test**

Test that the filter returns true for txs touching NTT manager / relayer programs with `err === null`, false otherwise. Test program-allowlist is exhaustive (USDC.s manager, ONyc manager, relayer ID).

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL with "Cannot find module './filter'"

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/webapp/src/lib/history/filter.ts
import type { ParsedTransactionWithMeta } from '@solana/web3.js'
import { USDC_NTT_MANAGER, ONYC_NTT_MANAGER, RELAYER_PROGRAM_ID } from '@/constants'

const ALLOWLIST = new Set([USDC_NTT_MANAGER.toBase58(), ONYC_NTT_MANAGER.toBase58(), RELAYER_PROGRAM_ID.toBase58()])

export function isBridgeTx(tx: ParsedTransactionWithMeta | null): boolean {
  if (!tx || tx.meta?.err) return false
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58())
  return keys.some(k => ALLOWLIST.has(k))
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/lib/history/filter.ts packages/webapp/src/lib/history/filter.test.ts
git commit -m "feat(webapp): isBridgeTx allowlist predicate"
```

### Task 1B.2: Event extractor — pre/post token-balance delta

**Files:**
- Create: `packages/webapp/src/lib/history/extract.ts`
- Test: `packages/webapp/src/lib/history/extract.test.ts`

- [ ] **Step 1: Write the failing test**

Given a parsed tx with `preTokenBalances` and `postTokenBalances`, extract the user's ATA delta as a signed `bigint`. Negative = burn, positive = receive.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/webapp/src/lib/history/extract.ts
import type { ParsedTransactionWithMeta } from '@solana/web3.js'

export function extractAtaDelta(tx: ParsedTransactionWithMeta, ata: string): bigint | null {
  const pre = tx.meta?.preTokenBalances?.find(b => b.owner === undefined ? false : tx.transaction.message.accountKeys[b.accountIndex]?.pubkey.toBase58() === ata)
  const post = tx.meta?.postTokenBalances?.find(b => tx.transaction.message.accountKeys[b.accountIndex]?.pubkey.toBase58() === ata)
  if (!pre && !post) return null
  const preAmt = BigInt(pre?.uiTokenAmount.amount ?? '0')
  const postAmt = BigInt(post?.uiTokenAmount.amount ?? '0')
  return postAmt - preAmt
}
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/lib/history/extract.ts packages/webapp/src/lib/history/extract.test.ts
git commit -m "feat(webapp): extract user ATA delta from parsed tx"
```

### Task 1B.3: `useActivityHistory` hook

**Files:**
- Create: `packages/webapp/src/hooks/useActivityHistory.ts`
- Test: `packages/webapp/src/hooks/useActivityHistory.test.tsx`

- [ ] **Step 1: Write the failing test**

Hook accepts owner pubkey, derives canonical USDC.s + ONyc ATAs, queries `getSignaturesForAddress` per ATA, fetches each tx, applies `isBridgeTx`, extracts delta, returns event list sorted desc by `blockTime`. Handles pagination via `before` cursor per ATA.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

(See `useTransferHistory.ts` shape from Path A; differs only in source. Two cursors merged into one stream.)

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/hooks/useActivityHistory.ts packages/webapp/src/hooks/useActivityHistory.test.tsx
git commit -m "feat(webapp): useActivityHistory hook (event-list)"
```

### Task 1B.4: `Activity` UI section

**Files:**
- Create: `packages/webapp/src/components/Activity.tsx`
- Modify: `packages/webapp/src/app/page.tsx`

- [ ] **Step 1: Write the failing test**

Renders one row per event (not per flow). Header: "Activity". Each row shows direction (sent/received), amount, mint, time, link to explorer.

- [ ] **Step 2: Run test, verify fail**
- [ ] **Step 3: Implement (mirrors `AllTransfers.tsx` shape; rows are events not flows)**
- [ ] **Step 4: Run tests, verify pass**
- [ ] **Step 5: Commit**

```bash
git commit -m "feat(webapp): Activity section behind feature flag"
```

### Task 1B.5: Documentation of scope and known gaps

**Files:**
- Create: `docs/superpowers/specs/2026-05-09-activity-view-scope.md`

Document explicitly:
- Canonical ATA only — auxiliary token accounts not enumerated
- Token-2022 not supported
- Failed burns excluded (filter requires `err === null`)
- Status: implicit (rows not paired)
- Requires archival FOGO RPC

- [ ] **Step 1: Write doc**
- [ ] **Step 2: Commit**

```bash
git commit -m "docs: activity view scope and known gaps"
```

---

## Out of scope (separate plans, not this one)

1. **Custom indexer** — if Phase 0 reveals neither Wormholescan nor session-signer enumeration works, requires its own plan and likely weeks of work.
2. **Granular withdraw queue states** — `awaiting-vaa`, `rate-limited`, `queued-for-redemption`, etc. Layered on top of either path as Phase 2.
3. **Token-2022 support** — separate effort, likely requires touching balance reads elsewhere in the app first.
4. **Cross-chain Solana-side history** — out of scope; the user-facing chain is FOGO.

## Definition of done

- Phase 0 findings committed.
- Either Path A or Path B implemented per Phase 0 decision.
- New section feature-flagged off by default.
- Existing `PendingTxList` behavior unchanged.
- Test coverage on filter/extract/client modules + hook integration test.
- Manual QA in staging with a wallet that has known prior bridges.
- Rollback documented (toggle the env flag).
