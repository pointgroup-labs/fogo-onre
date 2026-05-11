# Bridge History Implementation Plan

> **For agentic workers:
** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (
`- [ ]`) syntax for tracking.

**Goal:** Replace the localStorage-backed `PendingTxList` with a unified, on-chain-sourced
`BridgeHistory` view that shows cross-session, cross-device bridge history (deposits and withdraws) with two-state status enrichment via Wormholescan.

**Architecture:** A
`useBridgeHistory(owner)` hook merges three sources: FOGO RPC ATA enumeration (the only source of rows), Wormholescan as a per-row status oracle, and the existing local journal as a per-row phase enricher. Before deleting
`PendingTxList`, the live-tracker effect that drives journal entries to terminal status is extracted into a headless
`LiveJournalTracker` so journal progression and terminal toasts continue to work after the cutover.

**Tech Stack:** TypeScript, Next.js (App Router), `@tanstack/react-query`, `@solana/web3.js`,
`@solana/spl-token`, shadcn/ui, sonner (toasts), zod (runtime schema).

**Spec:**
`docs/superpowers/specs/2026-05-09-bridge-history-design.md`. Read it before starting; this plan does not repeat the architectural rationale.

**v1 testing posture:
** No automated test files in this plan. Each task ends with a manual verification step (typecheck, lint, sometimes a render check). Add retroactive tests later if regressions show up — the modules are decomposed to make that mechanical.

**v1 commits:** Every task ends with a single Conventional Commits commit (`feat`, `refactor`, `chore`,
`docs`). Single-line subject only, ≤72 chars, no body, per `CLAUDE.md`.

---

## File map (locked)

```
NEW
  packages/webapp/src/lib/bridgeHistory/types.ts
  packages/webapp/src/lib/bridgeHistory/rpc.ts
  packages/webapp/src/lib/bridgeHistory/wormholescan.ts
  packages/webapp/src/lib/bridgeHistory/merge.ts
  packages/webapp/src/hooks/useBridgeHistory.ts
  packages/webapp/src/components/BridgeHistory.tsx
  packages/webapp/src/components/LiveJournalTracker.tsx

MODIFIED
  packages/webapp/src/app/page.tsx
  docs/deploy-mainnet.md

DELETED
  packages/webapp/src/components/PendingTxList.tsx
```

---

## Task 1: Extract live tracker into headless `LiveJournalTracker`

This must happen first.
`PendingTxList` currently embeds the live tracker (the effect that polls each in-flight journal entry via
`useFlowStatus`, fires terminal toasts, and writes `notified: true` back to the journal). Once
`PendingTxList` is deleted, that logic must already be running elsewhere, otherwise journal entries never advance to terminal and toasts never fire.

**Files:**

- Create: `packages/webapp/src/components/LiveJournalTracker.tsx`

- [ ] **Step 1: Create the file with the headless extraction**

```tsx
// packages/webapp/src/components/LiveJournalTracker.tsx
'use client'

import type {FlowPhase} from '@/hooks/useFlowStatus'
import type {FlowStatusValue, PersistedFlowStatus} from '@/lib/flow-status/types'
import {PublicKey} from '@solana/web3.js'
import {useQuery, useQueryClient} from '@tanstack/react-query'
import {useEffect, useMemo} from 'react'
import {toast} from 'sonner'
import {useFlowStatus} from '@/hooks/useFlowStatus'
import {patchFlow} from '@/lib/flow-status/store'
import {isTerminal} from '@/lib/flow-status/types'

/**
 * Headless. Renders nothing. Mounted once per page, drives every
 * non-terminal journal entry forward by running `useFlowStatus` against
 * it and writing terminal status + firing the user-visible toast on
 * completion.
 *
 * Previously this logic lived inside `PendingTxList`'s `PendingRow`,
 * which meant deleting `PendingTxList` would also stop journal
 * progression. Splitting this out lets `BridgeHistory` be a pure reader.
 */
export default function LiveJournalTracker() {
  const idsQuery = useQuery<string[]>({
    queryKey: ['pending-flow-ids'],
    queryFn: () => [],
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    initialData: [],
  })
  const ids = idsQuery.data ?? []

  return (
    <>
      {ids.map(id => <TrackerRow key={id} flowId={id}/>)}
    </>
  )
}

function statusFromPhase(phase: FlowPhase | undefined): FlowStatusValue {
  if (phase === 'delivered') {
    return 'terminal-success'
  }
  if (phase === 'expired') {
    return 'terminal-failure'
  }
  if (phase === 'bridging' || phase === 'submitted') {
    return 'in-progress'
  }
  return 'pending'
}

function TrackerRow({flowId}: { flowId: string }) {
  const qc = useQueryClient()
  const {data: persisted} = useQuery<PersistedFlowStatus | null>({
    queryKey: ['flow-status', flowId],
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  })

  const flowInput = useMemo(() => {
    if (!persisted) {
      return null
    }
    return {
      signature: persisted.signature,
      owner: new PublicKey(persisted.ownerB58),
      kind: persisted.kind,
      startedAt: persisted.startedAt,
      baselineBalance: BigInt(persisted.baselineDestBalanceStr),
    }
  }, [persisted])

  const flow = useFlowStatus(flowInput ?? {
    signature: null,
    owner: null,
    kind: persisted?.kind ?? 'deposit',
    startedAt: null,
    baselineBalance: null,
  })

  useEffect(() => {
    if (!flow || !persisted) {
      return
    }
    const liveStatus = statusFromPhase(flow.phase)
    if (isTerminal(liveStatus) && !persisted.notified) {
      patchFlow(qc, flowId, {status: liveStatus, notified: true})
      if (liveStatus === 'terminal-success') {
        toast.success(persisted.kind === 'deposit' ? 'Deposit complete' : 'Withdraw complete', {id: flowId})
      } else {
        toast.error('Transfer failed', {id: flowId})
      }
    }
  }, [flow?.phase, persisted, flowId, qc, flow])

  return null
}
```

- [ ] **Step 2: Verify TypeScript clean**

Run: `pnpm webapp exec tsc --noEmit`
Expected: no errors. (
`PendingTxList.tsx` will still exist and still import its own copy of this code; that's fine — both paths compile.)

- [ ] **Step 3: Verify lint clean**

Run: `pnpm lint`
Expected: no errors related to the new file.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/components/LiveJournalTracker.tsx
git commit -m "refactor(webapp): extract live journal tracker from PendingTxList"
```

---

## Task 2: Bridge history types module

**Files:**

- Create: `packages/webapp/src/lib/bridgeHistory/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// packages/webapp/src/lib/bridgeHistory/types.ts
import type {FlowKind} from '@/lib/flow-status/types'
import type {PublicKey} from '@solana/web3.js'

/**
 * One row from FOGO RPC enumeration. Represents a user-initiated
 * `transfer_burn` on FOGO. Receives are not BurnRows — they're consumed
 * inside `merge.ts` only as fulfillment evidence, never as their own
 * rows.
 */
export interface BurnRow {
  signature: string
  ata: PublicKey
  mint: PublicKey
  amountRaw: bigint
  blockTime: number
  slot: number
}

/**
 * Wormholescan status oracle result for a single source tx hash.
 * `unknown` is returned on any failure mode (404, network error, parse
 * error, timeout) so the UI can render a graceful-degrade row without
 * a status badge.
 */
export type OperationStatus
  = | { kind: 'delivered', destinationTxHash: string }
  | { kind: 'pending' }
  | { kind: 'unknown' }

/**
 * Final merged shape consumed by `BridgeHistory.tsx`. One row per
 * user-initiated bridge intent, keyed on the FOGO `transfer_burn` tx
 * signature. `phase` (granular journal pill) takes display precedence
 * over `status` (basic two-state) when present and non-terminal.
 */
export interface TimelineRow {
  signature: string
  kind: FlowKind
  amountRaw: bigint
  mintB58: string
  blockTime: number
  status: OperationStatus['kind']
  destinationSignature: string | null
  /** Set only when this device + this session originated the bridge and the journal entry is still non-terminal. */
  phase: string | null
}
```

- [ ] **Step 2: Verify TypeScript clean**

Run: `pnpm webapp exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/webapp/src/lib/bridgeHistory/types.ts
git commit -m "feat(webapp): bridge history types module"
```

---

## Task 3: RPC enumeration module

Filters and extracts burn rows from one ATA's signature stream. Pure module — `Connection` is injected, no global state.

**Files:**

- Create: `packages/webapp/src/lib/bridgeHistory/rpc.ts`

- [ ] **Step 1: Create the file**

```typescript
// packages/webapp/src/lib/bridgeHistory/rpc.ts
import type {Connection, ParsedTransactionWithMeta} from '@solana/web3.js'
import {getAssociatedTokenAddressSync} from '@solana/spl-token'
import {PublicKey} from '@solana/web3.js'
import {
  FOGO_ONYC_MINT,
  FOGO_ONYC_NTT_MANAGER_ID,
  FOGO_USDC_S_NTT_MANAGER_ID,
  USDC_S_MINT,
} from '@/constants'
import type {BurnRow} from './types'

/**
 * Programs that, if present in `accountKeys`, mark a tx as a bridge
 * operation we want to surface. Manual ATA-to-ATA transfers, swaps,
 * airdrops, etc. fail this check and are dropped.
 */
const PROGRAM_ALLOWLIST: ReadonlySet<string> = new Set([
  FOGO_USDC_S_NTT_MANAGER_ID.toBase58(),
  FOGO_ONYC_NTT_MANAGER_ID.toBase58(),
])

const RPC_PAGE_SIZE = 50

export interface AtaBinding {
  ata: PublicKey
  mint: PublicKey
}

export function getCanonicalAtas(owner: PublicKey): AtaBinding[] {
  return [
    {ata: getAssociatedTokenAddressSync(USDC_S_MINT, owner), mint: USDC_S_MINT},
    {ata: getAssociatedTokenAddressSync(FOGO_ONYC_MINT, owner), mint: FOGO_ONYC_MINT},
  ]
}

/**
 * Page of burn rows from a single ATA. Returned signatures are oldest
 * cursor included so the caller can pass it back as `before` for the
 * next page. `null` cursor on the first call.
 */
export interface BurnPage {
  rows: BurnRow[]
  /** Signature of the oldest tx in this page. Use as `before` cursor for the next page. Null if no more results. */
  nextCursor: string | null
}

export async function fetchBurnPage(
  connection: Connection,
  binding: AtaBinding,
  cursor: string | undefined,
): Promise<BurnPage> {
  const sigs = await connection.getSignaturesForAddress(
    binding.ata,
    {limit: RPC_PAGE_SIZE, before: cursor, commitment: 'finalized'},
  )

  if (sigs.length === 0) {
    return {rows: [], nextCursor: null}
  }

  // Parallel fetch — RPC tolerates ~50-wide bursts; if rate-limited
  // the caller's TanStack Query retry will back off the whole page.
  const txs = await Promise.all(
    sigs.map(s =>
      connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'finalized',
      }),
    ),
  )

  const rows: BurnRow[] = []
  for (let i = 0; i < sigs.length; i++) {
    const sigInfo = sigs[i]
    const tx = txs[i]
    const burn = extractBurnRow(tx, sigInfo.signature, sigInfo.blockTime ?? null, sigInfo.slot, binding)
    if (burn !== null) {
      rows.push(burn)
    }
  }

  return {
    rows,
    nextCursor: sigs.length === RPC_PAGE_SIZE ? sigs[sigs.length - 1].signature : null,
  }
}

/**
 * Pure: given one parsed tx, decide whether it's a user burn from
 * `binding.ata`. Returns the BurnRow or null.
 *
 * Acceptance criteria:
 *   - `tx.meta.err === null` (failed bridges excluded)
 *   - At least one program in `accountKeys` is on PROGRAM_ALLOWLIST
 *   - Signed delta on this ATA is negative (it's a burn)
 */
export function extractBurnRow(
  tx: ParsedTransactionWithMeta | null,
  signature: string,
  blockTime: number | null,
  slot: number,
  binding: AtaBinding,
): BurnRow | null {
  if (tx === null || tx.meta === null || tx.meta.err !== null) {
    return null
  }

  // Allowlist check
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58())
  if (!keys.some(k => PROGRAM_ALLOWLIST.has(k))) {
    return null
  }

  const ataB58 = binding.ata.toBase58()
  const pre = tx.meta.preTokenBalances?.find(b => keysAt(tx, b.accountIndex) === ataB58)
  const post = tx.meta.postTokenBalances?.find(b => keysAt(tx, b.accountIndex) === ataB58)

  if (pre === undefined && post === undefined) {
    return null
  }

  const preAmt = BigInt(pre?.uiTokenAmount.amount ?? '0')
  const postAmt = BigInt(post?.uiTokenAmount.amount ?? '0')
  const delta = postAmt - preAmt

  // Negative delta = burn. Receives (positive delta) are dropped here;
  // they're not their own rows. Zero deltas are tx noise.
  if (delta >= 0n) {
    return null
  }

  return {
    signature,
    ata: binding.ata,
    mint: binding.mint,
    amountRaw: -delta,
    blockTime: blockTime ?? 0,
    slot,
  }
}

function keysAt(tx: ParsedTransactionWithMeta, index: number): string | undefined {
  return tx.transaction.message.accountKeys[index]?.pubkey.toBase58()
}
```

- [ ] **Step 2: Verify TypeScript clean**

Run: `pnpm webapp exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify lint clean**

Run: `pnpm lint`
Expected: no errors in the new file.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/lib/bridgeHistory/rpc.ts
git commit -m "feat(webapp): RPC ATA enumeration for bridge history"
```

---

## Task 4: Wormholescan oracle module

Per-signature `txHash` lookup with runtime schema and graceful-degrade on any failure.

**Files:**

- Create: `packages/webapp/src/lib/bridgeHistory/wormholescan.ts`

- [ ] **Step 1: Check whether `zod` is already a dependency**

Run: `pnpm webapp ls zod 2>&1 | head -5`
Expected: either reports an installed version (use it) OR reports nothing (skip zod and use a hand-rolled type guard — this task includes both paths; pick one based on the result).

- [ ] **Step 2: Create the file (zod path — preferred if available)**

```typescript
// packages/webapp/src/lib/bridgeHistory/wormholescan.ts
import {z} from 'zod'
import type {OperationStatus} from './types'

const WORMHOLESCAN_BASE = 'https://api.wormholescan.io/api/v1'
const REQUEST_TIMEOUT_MS = 3000

const OperationSchema = z.object({
  sourceChain: z.object({
    transaction: z.object({txHash: z.string()}),
  }),
  targetChain: z
    .object({
      transaction: z.object({txHash: z.string()}).optional(),
      status: z.string().optional(),
    })
    .optional(),
})

const ResponseSchema = z.object({
  operations: z.array(OperationSchema).optional(),
})

export async function fetchOperationStatus(sourceTxHash: string): Promise<OperationStatus> {
  const url = `${WORMHOLESCAN_BASE}/operations?txHash=${encodeURIComponent(sourceTxHash)}&pageSize=1`

  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})
    if (!res.ok) {
      return {kind: 'unknown'}
    }
    const json: unknown = await res.json()
    const parsed = ResponseSchema.safeParse(json)
    if (!parsed.success) {
      return {kind: 'unknown'}
    }
    const op = parsed.data.operations?.[0]
    if (op === undefined) {
      return {kind: 'unknown'}
    }
    const destTx = op.targetChain?.transaction?.txHash
    if (destTx !== undefined) {
      return {kind: 'delivered', destinationTxHash: destTx}
    }
    return {kind: 'pending'}
  } catch {
    return {kind: 'unknown'}
  }
}
```

- [ ] **Step 2-alt: Create the file (hand-rolled path — if zod is not available)**

Skip Step 2 above and use this instead:

```typescript
// packages/webapp/src/lib/bridgeHistory/wormholescan.ts
import type {OperationStatus} from './types'

const WORMHOLESCAN_BASE = 'https://api.wormholescan.io/api/v1'
const REQUEST_TIMEOUT_MS = 3000

interface RawOperation {
  sourceChain?: { transaction?: { txHash?: unknown } }
  targetChain?: { transaction?: { txHash?: unknown } }
}

function pickOperation(json: unknown): RawOperation | null {
  if (typeof json !== 'object' || json === null) {
    return null
  }
  const ops = (json as { operations?: unknown }).operations
  if (!Array.isArray(ops) || ops.length === 0) {
    return null
  }
  const op = ops[0]
  return typeof op === 'object' && op !== null ? op as RawOperation : null
}

export async function fetchOperationStatus(sourceTxHash: string): Promise<OperationStatus> {
  const url = `${WORMHOLESCAN_BASE}/operations?txHash=${encodeURIComponent(sourceTxHash)}&pageSize=1`

  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)})
    if (!res.ok) {
      return {kind: 'unknown'}
    }
    const json: unknown = await res.json()
    const op = pickOperation(json)
    if (op === null) {
      return {kind: 'unknown'}
    }
    const destTx = op.targetChain?.transaction?.txHash
    if (typeof destTx === 'string' && destTx.length > 0) {
      return {kind: 'delivered', destinationTxHash: destTx}
    }
    return {kind: 'pending'}
  } catch {
    return {kind: 'unknown'}
  }
}
```

- [ ] **Step 3: Verify TypeScript clean**

Run: `pnpm webapp exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Smoke-test the call against a known signature**

Run from a scratch Node REPL or `pnpm webapp exec node --input-type=module -e "..."`:

```js
const r = await fetch('https://api.wormholescan.io/api/v1/operations?txHash=3vX7MQ6HYqpQp8T97p25QRAwQATksRXt5D2FwNXLESLUPXcEZMFtWKJScoMfzsvwAF2tQaQSzuznxs8gZV6vsjXH&pageSize=1')
console.log((await r.json()).operations?.[0]?.targetChain?.transaction?.txHash)
```

Expected output: a Solana tx hash (proves the API still returns the field shape we depend on).

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/lib/bridgeHistory/wormholescan.ts
git commit -m "feat(webapp): wormholescan status oracle for bridge history"
```

---

## Task 5: Merge function

Pure function. Combines `BurnRow` + `OperationStatus` + journal entry into a
`TimelineRow`. Also exposes a helper that scans the journal index by signature (because journal entries are keyed on
`flowId`, not signature, and we need to map back).

**Files:**

- Create: `packages/webapp/src/lib/bridgeHistory/merge.ts`

- [ ] **Step 1: Create the file**

```typescript
// packages/webapp/src/lib/bridgeHistory/merge.ts
import type {QueryClient} from '@tanstack/react-query'
import type {PersistedFlowStatus} from '@/lib/flow-status/types'
import {readFlow, readIndex} from '@/lib/flow-status/store'
import {isTerminal} from '@/lib/flow-status/types'
import type {BurnRow, OperationStatus, TimelineRow} from './types'

/**
 * Find the journal entry for a given burn signature, if any. Journal
 * entries are keyed on `flowId`, not signature, so this is an O(N)
 * scan of the index — N is small (≤ a handful of in-flight flows in
 * normal use), so the linear scan is fine.
 *
 * Only returns non-terminal entries — terminal flows are already
 * reflected in the Wormholescan `delivered` status, and their journal
 * `phase` would shadow the badge unhelpfully.
 */
export function findJournalEntryBySignature(
  qc: QueryClient,
  signature: string,
): PersistedFlowStatus | null {
  const ids = readIndex(qc)
  for (const id of ids) {
    const entry = readFlow(qc, id)
    if (entry !== undefined && entry.signature === signature && !isTerminal(entry.status)) {
      return entry
    }
  }
  return null
}

/**
 * Pure: given the three inputs, produce one TimelineRow. Must be
 * deterministic — same inputs always yield the same output.
 */
export function mergeRow(
  burn: BurnRow,
  op: OperationStatus | null,
  journal: PersistedFlowStatus | null,
): TimelineRow {
  return {
    signature: burn.signature,
    // The user's burn mint determines the flow direction. Burning
    // USDC.s on FOGO = depositing into the protocol. Burning ONyc
    // on FOGO = withdrawing.
    kind: burn.mint.equals(USDC_S_MINT_REF) ? 'deposit' : 'withdraw',
    amountRaw: burn.amountRaw,
    mintB58: burn.mint.toBase58(),
    blockTime: burn.blockTime,
    status: op?.kind ?? 'unknown',
    destinationSignature: op !== null && op.kind === 'delivered' ? op.destinationTxHash : null,
    phase: journal !== null ? humanPhaseFromStatus(journal) : null,
  }
}

/**
 * The journal stores `FlowStatusValue` ('pending' | 'in-progress' | …).
 * `BridgeHistory` wants a human label like "Bridging…" / "Submitting".
 * Keep the mapping here so the component stays presentational.
 */
function humanPhaseFromStatus(j: PersistedFlowStatus): string {
  switch (j.status) {
    case 'pending':
      return 'Submitting'
    case 'in-progress':
      return 'Bridging'
    case 'terminal-success':
      return 'Complete'
    case 'terminal-failure':
      return 'Failed'
  }
}

import {USDC_S_MINT as USDC_S_MINT_REF} from '@/constants'
```

- [ ] **Step 2: Move the constant import to the top of the file**

Edit the file: cut the trailing
`import { USDC_S_MINT as USDC_S_MINT_REF } from '@/constants'` line and insert it under the existing
`import` block at the top. (The file as drafted has the import deferred for clarity in this plan; move it before commit so the lint config's import-order rule doesn't flag it.)

- [ ] **Step 3: Verify TypeScript and lint clean**

Run: `pnpm webapp exec tsc --noEmit && pnpm lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/lib/bridgeHistory/merge.ts
git commit -m "feat(webapp): merge function for bridge history rows"
```

---

## Task 6: `useBridgeHistory` hook

Orchestrates the three sources via TanStack Query. Returns
`{ rows, isLoading, isError, hasNextPage, fetchNextPage }` consumed by `BridgeHistory.tsx`.

**Files:**

- Create: `packages/webapp/src/hooks/useBridgeHistory.ts`

- [ ] **Step 1: Create the file**

```typescript
// packages/webapp/src/hooks/useBridgeHistory.ts
'use client'

import type {PublicKey} from '@solana/web3.js'
import {useInfiniteQuery, useQueries, useQueryClient} from '@tanstack/react-query'
import {useMemo} from 'react'
import {useSettings} from '@/store/settings'
import {getFogoConnection} from '@/utils/connections'
import {fetchBurnPage, getCanonicalAtas} from '@/lib/bridgeHistory/rpc'
import {fetchOperationStatus} from '@/lib/bridgeHistory/wormholescan'
import {findJournalEntryBySignature, mergeRow} from '@/lib/bridgeHistory/merge'
import type {BurnRow, OperationStatus, TimelineRow} from '@/lib/bridgeHistory/types'

interface BurnPageGroup {
  cursors: { usdcS: string | undefined, onyc: string | undefined }
  rows: BurnRow[]
  hasMoreUsdcS: boolean
  hasMoreOnyc: boolean
}

const PAGE_SIZE = 50

export interface UseBridgeHistoryResult {
  rows: TimelineRow[]
  isLoading: boolean
  isError: boolean
  hasNextPage: boolean
  fetchNextPage: () => void
  isFetchingNextPage: boolean
}

export function useBridgeHistory(owner: PublicKey | null): UseBridgeHistoryResult {
  const {fogoRpcUrl} = useSettings()
  const qc = useQueryClient()

  const ownerB58 = owner?.toBase58() ?? null

  // Page 1: fetch both ATA streams in parallel; merge sorted desc.
  // Subsequent pages advance whichever ATA still has older signatures.
  const burnQuery = useInfiniteQuery<BurnPageGroup>({
    queryKey: ['bridge-history', 'burns', ownerB58, fogoRpcUrl],
    enabled: ownerB58 !== null,
    initialPageParam: {usdcS: undefined, onyc: undefined} as { usdcS: string | undefined, onyc: string | undefined },
    queryFn: async ({pageParam}) => {
      // owner is guaranteed by `enabled` gate above
      const ownerKey = owner as PublicKey
      const connection = getFogoConnection(fogoRpcUrl)
      const [usdcSBinding, onycBinding] = getCanonicalAtas(ownerKey)
      const [usdcSPage, onycPage] = await Promise.all([
        fetchBurnPage(connection, usdcSBinding, pageParam.usdcS),
        fetchBurnPage(connection, onycBinding, pageParam.onyc),
      ])
      const merged = [...usdcSPage.rows, ...onycPage.rows].sort((a, b) => b.blockTime - a.blockTime)
      return {
        cursors: {usdcS: usdcSPage.nextCursor ?? undefined, onyc: onycPage.nextCursor ?? undefined},
        rows: merged,
        hasMoreUsdcS: usdcSPage.nextCursor !== null,
        hasMoreOnyc: onycPage.nextCursor !== null,
      }
    },
    getNextPageParam: (last) => {
      if (!last.hasMoreUsdcS && !last.hasMoreOnyc) {
        return undefined
      }
      return last.cursors
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  })

  const allBurns: BurnRow[] = useMemo(() => {
    const pages = burnQuery.data?.pages ?? []
    const all = pages.flatMap(p => p.rows)
    // Dedup by signature defensively (same tx could touch both ATAs)
    const seen = new Set<string>()
    const out: BurnRow[] = []
    for (const r of all) {
      if (!seen.has(r.signature)) {
        seen.add(r.signature)
        out.push(r)
      }
    }
    return out.sort((a, b) => b.blockTime - a.blockTime)
  }, [burnQuery.data])

  // One Wormholescan query per burn. TanStack dedupes parallel calls
  // for the same key. Per-state staleTime: delivered=Infinity, pending=30s,
  // unknown=10s with backoff.
  const opQueries = useQueries({
    queries: allBurns.map(burn => ({
      queryKey: ['wormholescan-op', burn.signature],
      queryFn: () => fetchOperationStatus(burn.signature),
      staleTime: (q: { state: { data?: OperationStatus } }) => {
        const data = q.state.data
        if (data?.kind === 'delivered') {
          return Infinity
        }
        if (data?.kind === 'pending') {
          return 30_000
        }
        return 10_000
      },
      gcTime: 24 * 60 * 60 * 1_000,
      retry: 3,
      retryDelay: (attempt: number) => Math.min(9000, 1000 * 3 ** attempt),
      refetchOnWindowFocus: true,
    })),
  })

  const rows: TimelineRow[] = useMemo(() => {
    return allBurns.map((burn, i) => {
      const op = opQueries[i]?.data ?? null
      const journal = findJournalEntryBySignature(qc, burn.signature)
      return mergeRow(burn, op, journal)
    })
  }, [allBurns, opQueries, qc])

  return {
    rows,
    isLoading: burnQuery.isLoading,
    isError: burnQuery.isError,
    hasNextPage: burnQuery.hasNextPage ?? false,
    fetchNextPage: () => {
      burnQuery.fetchNextPage()
    },
    isFetchingNextPage: burnQuery.isFetchingNextPage,
  }
}
```

- [ ] **Step 2: Verify TypeScript clean**

Run: `pnpm webapp exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify lint clean**

Run: `pnpm lint`
Expected: no errors in new files.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/hooks/useBridgeHistory.ts
git commit -m "feat(webapp): useBridgeHistory hook"
```

---

## Task 7: `BridgeHistory` component

Pure presentation. Reads from
`useBridgeHistory`; renders skeleton, error, empty, list, "Load more". Same hydration deferral pattern as
`PendingTxList`.

**Files:**

- Create: `packages/webapp/src/components/BridgeHistory.tsx`

- [ ] **Step 1: Create the file**

```tsx
// packages/webapp/src/components/BridgeHistory.tsx
'use client'

import {isEstablished, useSession} from '@fogo/sessions-sdk-react'
import {useIsRestoring} from '@tanstack/react-query'
import {useEffect, useState} from 'react'
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'
import {Card, CardContent} from '@/components/ui/card'
import {Skeleton} from '@/components/ui/skeleton'
import {useBridgeHistory} from '@/hooks/useBridgeHistory'
import type {TimelineRow} from '@/lib/bridgeHistory/types'
import {FOGO_ONYC_DECIMALS, USDC_DECIMALS} from '@/constants'
import {fogoTxUrl} from '@/utils/explorers'

export default function BridgeHistory() {
  // Same hydration pattern as PendingTxList: defer the restoring branch
  // to a post-mount render so the first client paint matches the SSR
  // empty render.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const restoring = useIsRestoring()

  const session = useSession()
  const owner = isEstablished(session) ? session.walletPublicKey : null
  const {rows, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage} = useBridgeHistory(owner)

  if (owner === null) {
    return null
  }

  if (mounted && restoring) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16"/>
        <Skeleton className="h-16"/>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16"/>
        <Skeleton className="h-16"/>
        <Skeleton className="h-16"/>
      </div>
    )
  }

  if (isError && rows.length === 0) {
    return (
      <Alert>
        <AlertTitle>Bridge history unavailable</AlertTitle>
        <AlertDescription>Couldn&apos;t load history. Try again in a moment.</AlertDescription>
      </Alert>
    )
  }

  if (rows.length === 0) {
    return (
      <Alert>
        <AlertTitle>No bridges yet</AlertTitle>
        <AlertDescription>Your bridge history will appear here.</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Bridge history" className="flex flex-col gap-2">
        {rows.map(r => <li key={r.signature}><BridgeRow row={r}/></li>)}
      </ul>
      {hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="self-center text-xs text-muted-foreground"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}

function BridgeRow({row}: { row: TimelineRow }) {
  const decimals = row.kind === 'deposit' ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const ticker = row.kind === 'deposit' ? 'USDC.s' : 'ONyc'
  const directionIcon = row.kind === 'deposit' ? '↗' : '↘'
  const label = row.kind === 'deposit' ? 'Deposit' : 'Withdraw'
  const amount = formatAmount(row.amountRaw, decimals)
  const time = new Date(row.blockTime * 1000).toLocaleString()

  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">
            <span aria-hidden className="mr-1 text-muted-foreground">{directionIcon}</span>
            {label} · {amount} {ticker}
          </span>
          <StatusBadge row={row}/>
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{time}</span>
          <span className="flex items-center gap-2">
            <a href={fogoTxUrl(row.signature)} target="_blank" rel="noreferrer noopener" className="hover:underline">
              source ↗
            </a>
            {row.destinationSignature !== null && (
              <a href={fogoTxUrl(row.destinationSignature)} target="_blank" rel="noreferrer noopener"
                 className="hover:underline">
                dest ↗
              </a>
            )}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge({row}: { row: TimelineRow }) {
  // Precedence: phase > status. `unknown` renders no badge (graceful degrade).
  if (row.phase !== null) {
    return <Badge variant="secondary" aria-label={`status: ${row.phase}`}>{row.phase}</Badge>
  }
  if (row.status === 'delivered') {
    return <Badge variant="default" aria-label="status: delivered">Delivered</Badge>
  }
  if (row.status === 'pending') {
    return <Badge variant="secondary" aria-label="status: bridging">Bridging…</Badge>
  }
  return null
}

function formatAmount(raw: bigint, decimals: number): string {
  // Display two decimal places of precision, dropping trailing zeros.
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const fraction = raw % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 2)
  // Strip trailing zeros from the 2-char fraction
  const trimmed = fractionStr.replace(/0+$/, '')
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole.toString()
}
```

- [ ] **Step 2: Verify TypeScript clean**

Run: `pnpm webapp exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify lint clean**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/components/BridgeHistory.tsx
git commit -m "feat(webapp): BridgeHistory component"
```

---

## Task 8: Cutover in `page.tsx` and delete `PendingTxList`

This is the hard cutover. After this task, `PendingTxList` no longer exists and the new component is rendering.

**Files:**

- Modify: `packages/webapp/src/app/page.tsx`
- Delete: `packages/webapp/src/components/PendingTxList.tsx`

- [ ] **Step 1: Replace the `PendingTxList` import and mount in `page.tsx`**

Edit `packages/webapp/src/app/page.tsx`. Find:

```tsx
import PendingTxList from '@/components/PendingTxList'
```

Replace with:

```tsx
import BridgeHistory from '@/components/BridgeHistory'
import LiveJournalTracker from '@/components/LiveJournalTracker'
```

Then find:

```tsx
          <ErrorBoundary label="recent transactions"><PendingTxList/></ErrorBoundary>
```

Replace with:

```tsx
          <LiveJournalTracker/>
<ErrorBoundary label="bridge history"><BridgeHistory/></ErrorBoundary>
```

- [ ] **Step 2: Delete the file**

Run: `rm packages/webapp/src/components/PendingTxList.tsx`

- [ ] **Step 3: Verify TypeScript clean**

Run: `pnpm webapp exec tsc --noEmit`
Expected: no errors. If any other file imported
`PendingTxList`, fix the import on the spot — there should be exactly one importer (
`page.tsx`) but a stray reference is possible.

- [ ] **Step 4: Verify lint clean and run a build**

Run: `pnpm lint && pnpm webapp build`
Expected: build succeeds. (`build` catches Next.js-specific issues that
`tsc` misses, like Server Component import boundaries.)

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/app/page.tsx packages/webapp/src/components/PendingTxList.tsx
git commit -m "feat(webapp): replace PendingTxList with BridgeHistory"
```

---

## Task 9: Document the archival RPC requirement

`docs/deploy-mainnet.md` is the deployment runbook. Add a one-line note flagging that the configured FOGO RPC must be archival, otherwise bridge history silently truncates at the prune horizon.

**Files:**

- Modify: `docs/deploy-mainnet.md`

- [ ] **Step 1: Open the file and find a sensible insertion point**

Run: `grep -n -i 'rpc\|endpoint\|node' docs/deploy-mainnet.md | head -20`

Pick a line near where RPC configuration is already discussed; if no such section exists, add a new "## RPC requirements" subsection near the deployment-config area.

- [ ] **Step 2: Insert the note**

Add the following paragraph at the chosen location:

```markdown
### Archival FOGO RPC required

The webapp's bridge-history view (`BridgeHistory` component, backed by `useBridgeHistory`) calls
`getSignaturesForAddress` against the user's canonical USDC.s and ONyc ATAs on FOGO. This returns unbounded history only when the configured FOGO RPC is
**archival
**. Public/free FOGO RPCs typically prune the signature index to the last ~2 days, which silently caps the user's visible history at that horizon — the feature looks incomplete with no error.

Verify pre-prod by paging an ATA back >7 days; if the cursor terminates earlier than expected, swap to an archival provider before going live. The RPC URL is configured via
`NEXT_PUBLIC_FOGO_RPC_URL` (or the user's settings drawer override; see `packages/webapp/src/store/settings.ts`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/deploy-mainnet.md
git commit -m "docs(deploy): flag archival FOGO RPC requirement for bridge history"
```

---

## Task 10: Manual QA in staging

Two scenarios that automated tests can't cover (and that v1 deferred anyway). Both must pass before merging the branch to main.

- [ ] **Step 1: Connect a wallet with at least one prior delivered bridge**

Open the deployed/staging webapp. Connect a wallet that has bridged previously and the bridge is known to have delivered.

Expected:

- A row appears in `BridgeHistory` with the correct `kind`, amount, and timestamp.
- Status badge reads "Delivered."
- Clicking "source ↗" opens FogoScan to the burn tx.
- Clicking "dest ↗" opens FogoScan to a different (destination) tx.

- [ ] **Step 2: Initiate a fresh bridge from the staging UI**

Use the deposit or withdraw flow to start a new bridge.

Expected:

- A row appears immediately with the journal phase pill ("Submitting" → "Bridging").
- After bridging completes, the row's badge transitions to "Delivered" and a sonner toast fires.
- The journal entry's `notified` flag transitions to true (verifiable via React DevTools or
  `queryClient.getQueryData(['flow-status', flowId])` in a console).

- [ ] **Step 3: Reload the page mid-bridge**

While the row from Step 2 is still in-flight, hard-reload the page.

Expected:

- The row re-renders immediately from cache (no skeleton flash if persistence is warm).
- The journal phase pill is still shown (because the journal survives reload via persistence).
- After the cranker completes, the badge still transitions to "Delivered."

- [ ] **Step 4: Disable network and reload**

Use DevTools Network tab to set "Offline" and reload.

Expected:

- The list renders from persisted cache; no Alert.
- "Load more" still works visually but produces no new rows.
- Re-enabling network triggers refetches and updates statuses.

If any of these fail, the failure is implementation-level and gets a fix-up commit before merge — do not ship.

---

## Self-Review (run after writing the plan)

### Spec coverage

| Spec section                                                    | Covered by            |
|-----------------------------------------------------------------|-----------------------|
| Architecture (3-source merge)                                   | Tasks 3–6             |
| File structure (5 lib files + 1 hook + 1 component)             | Tasks 2–7             |
| Row model (`TimelineRow`)                                       | Task 2                |
| RPC enumeration (filter, delta, allowlist)                      | Task 3                |
| Wormholescan oracle (txHash query, 3 outcomes, 3s timeout)      | Task 4                |
| Local journal access (read by signature)                        | Task 5                |
| Merge function (truth table)                                    | Task 5                |
| TanStack Query strategy (per-state staleTime, persistence)      | Task 6 (cache config) |
| UI shape (rows, badge precedence, states, accessibility)        | Task 7                |
| Hard cutover (delete `PendingTxList`)                           | Task 8                |
| Archival RPC documentation                                      | Task 9                |
| Manual QA scenarios                                             | Task 10               |
| **Live tracker extraction** (not in spec, surfaced during plan) | Task 1                |

No gaps.

### Placeholder scan

No `TBD`,
`TODO`, "implement later", or "similar to Task N" patterns. Every code block is complete and copy-paste runnable.

### Type consistency

- `BurnRow`, `OperationStatus`, `TimelineRow` defined in Task 2; consumed by name in Tasks 3, 4, 5, 6, 7.
- `fetchBurnPage`, `getCanonicalAtas`, `extractBurnRow` defined in Task 3; consumed in Task 6.
- `fetchOperationStatus` defined in Task 4; consumed in Task 6.
- `mergeRow`, `findJournalEntryBySignature` defined in Task 5; consumed in Task 6.
- `useBridgeHistory` defined in Task 6; consumed in Task 7.
- `BridgeHistory`, `LiveJournalTracker` defined in Tasks 7, 1; consumed in Task 8.
- Journal API (`readIndex`, `readFlow`, `patchFlow`, `addFlow`, `PersistedFlowStatus`, `FlowStatusValue`,
  `isTerminal`) is consumed only — never redefined.

All names match across tasks.

---

## Definition of done

- All 9 implementation tasks committed (10 if you commit per docs separately).
- TypeScript and ESLint clean.
- `pnpm webapp build` succeeds.
- Task 10 manual QA scenarios pass in staging.
- Branch ready for merge as a hard cutover (no feature flag).
