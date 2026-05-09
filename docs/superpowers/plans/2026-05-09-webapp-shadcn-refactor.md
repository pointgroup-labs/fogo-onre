# Webapp shadcn/ui Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `packages/webapp/` to use shadcn/ui + Tailwind + Radix on the UI layer and TanStack Query 5 on the data layer, while preserving all bridge call semantics.

**Architecture:** shadcn components scaffolded into `src/components/ui/`. `react-hook-form` + `zod` for the transfer form. `sonner` for toasts. `next-themes` for dark/light. TanStack Query (with `PersistQueryClientProvider`) replaces hand-rolled fetching hooks and the Zustand pending-tx/toast stores. Wallet adapter is `@fogo/sessions-sdk-react` and is preserved.

**Tech Stack:** Next.js 16, React 19, Tailwind 4, TypeScript 6, shadcn/ui, Radix, react-hook-form, zod, sonner, next-themes, @tanstack/react-query 5, @tanstack/react-query-persist-client, zustand (kept for `settings` only).

**Spec:** `docs/superpowers/specs/2026-05-09-webapp-shadcn-refactor-design.md`

**Validation posture:** V1 — manual devnet smoke test, no automated tests. Verification commands per task are `pnpm --filter @fogo-onre/webapp dev` (boots) or `pnpm --filter @fogo-onre/webapp build` (compiles), plus visual confirmation where indicated. Commit after each task.

**Load-bearing files (semantically untouched — call sites only):**
- `packages/webapp/src/constants.ts`
- `packages/webapp/src/utils/transfer.ts`
- `packages/webapp/src/lib/bridge/*`
- All of `packages/sdk/`

---

## Task 0: Branch setup

**Files:** none

- [ ] **Step 1: Create a feature branch off `main`**

```bash
git -C /Users/tiamo/RustroverProjects/fogo-onre checkout -b refactor/webapp-shadcn
```

- [ ] **Step 2: Verify clean working tree**

Run: `git status`
Expected: "On branch refactor/webapp-shadcn", "nothing to commit, working tree clean".

---

## Task 1: Add npm dependencies

**Files:**
- Modify: `packages/webapp/package.json`

- [ ] **Step 1: Add runtime deps**

```bash
pnpm --filter @fogo-onre/webapp add \
  @tanstack/react-query@^5 \
  @tanstack/react-query-persist-client@^5 \
  @tanstack/query-sync-storage-persister@^5 \
  react-hook-form@^7 \
  @hookform/resolvers@^3 \
  zod@^3 \
  sonner@^1 \
  next-themes@^0.4 \
  lucide-react@latest \
  class-variance-authority@latest \
  tailwind-merge@latest \
  tailwindcss-animate@latest
```

- [ ] **Step 2: Add dev deps**

```bash
pnpm --filter @fogo-onre/webapp add -D \
  @tanstack/react-query-devtools@^5
```

- [ ] **Step 3: Verify install**

Run: `pnpm --filter @fogo-onre/webapp build`
Expected: build succeeds (the app still uses none of these yet, so no behavioral change).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/package.json pnpm-lock.yaml
git commit -m "chore(webapp): add shadcn/ui + tanstack query deps"
```

---

## Task 2: Run `shadcn init`

**Files (created by CLI):**
- `packages/webapp/components.json`
- `packages/webapp/src/lib/utils.ts`
- `packages/webapp/src/app/globals.css` (modified — shadcn token blocks added)
- `packages/webapp/tailwind.config.*` (verify for v4 — may not be created if Tailwind 4 in CSS-config mode)

- [ ] **Step 1: Run init**

```bash
cd packages/webapp && npx shadcn@latest init
```

When prompted:
- Style: **Default**
- Base color: **Neutral**
- Use CSS variables: **Yes**
- Tailwind config strategy: accept default for Tailwind v4 (CSS-config via `@theme` block in `globals.css`)

- [ ] **Step 2: Verify the `cn()` helper**

Read `packages/webapp/src/lib/utils.ts`. Confirm it exports a `cn` function combining `clsx` and `twMerge`. If not, write:

```ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

- [ ] **Step 3: Verify the dev server boots**

Run: `pnpm --filter @fogo-onre/webapp dev`
Expected: server starts, `http://localhost:3000` renders the existing UI (no visual change).
Stop the server with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/components.json packages/webapp/src/lib/utils.ts packages/webapp/src/app/globals.css packages/webapp/tailwind.config.* 2>/dev/null
git commit -m "chore(webapp): scaffold shadcn/ui (init)"
```

---

## Task 3: Add shadcn UI primitives

**Files (all created by CLI under `packages/webapp/src/components/ui/`):**
- `button.tsx`, `card.tsx`, `tabs.tsx`, `input.tsx`, `label.tsx`, `form.tsx`, `sheet.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `skeleton.tsx`, `alert.tsx`, `badge.tsx`, `scroll-area.tsx`, `separator.tsx`, `sonner.tsx`

- [ ] **Step 1: Add components**

```bash
cd packages/webapp && npx shadcn@latest add button card tabs input label form sheet dialog dropdown-menu skeleton alert badge scroll-area separator sonner
```

Accept overwrite prompts as needed.

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @fogo-onre/webapp build`
Expected: build succeeds. Components are present but unused — no runtime change.

- [ ] **Step 3: Commit**

```bash
git add packages/webapp/src/components/ui
git commit -m "chore(webapp): add shadcn primitives"
```

---

## Task 4: QueryClient helper

**Files:**
- Create: `packages/webapp/src/lib/query/client.ts`

- [ ] **Step 1: Write the client factory**

```ts
import { QueryClient } from '@tanstack/react-query'

declare global {
  // eslint-disable-next-line vars-on-top, no-var
  var __fogoQueryClient: QueryClient | undefined
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        retry: 2,
        refetchOnWindowFocus: false,
        throwOnError: false,
      },
      mutations: {
        retry: false,
      },
    },
  })
}

export function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    // Server: a fresh client per request.
    return makeQueryClient()
  }
  // Browser: a single client memoized on globalThis to survive HMR.
  if (!globalThis.__fogoQueryClient) {
    globalThis.__fogoQueryClient = makeQueryClient()
  }
  return globalThis.__fogoQueryClient
}
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @fogo-onre/webapp build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/webapp/src/lib/query/client.ts
git commit -m "feat(webapp): add tanstack query client factory"
```

---

## Task 5: Persistence wrapper

**Files:**
- Create: `packages/webapp/src/lib/query/persist.tsx`

- [ ] **Step 1: Write the wrapper**

```tsx
'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { getQueryClient } from './client'

const PERSIST_KEY = 'fogo-onre.queries.v1'

function shouldPersistKey(key: readonly unknown[]): boolean {
  const head = key[0]
  return head === 'flow-status' || head === 'pending-flow-ids'
}

export default function QueryProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => getQueryClient())

  // Server render: plain QueryClientProvider (no localStorage available).
  if (typeof window === 'undefined') {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  const persister = createSyncStoragePersister({
    storage: window.localStorage,
    key: PERSIST_KEY,
  })

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => shouldPersistKey(query.queryKey),
        },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}
```

- [ ] **Step 2: Build**

Run: `pnpm --filter @fogo-onre/webapp build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/webapp/src/lib/query/persist.tsx
git commit -m "feat(webapp): add persisted query provider"
```

---

## Task 6: Rewrite `providers.tsx`

**Files:**
- Modify: `packages/webapp/src/providers.tsx`

- [ ] **Step 1: Read the current file**

Read `packages/webapp/src/providers.tsx` to confirm the current `FogoSessionProvider` config (props, key behavior).

- [ ] **Step 2: Rewrite**

```tsx
'use client'

/* eslint-disable perfectionist/sort-imports -- polyfill MUST be first */
import './polyfills'

import type { ReactNode } from 'react'

import { FogoSessionProvider } from '@fogo/sessions-sdk-react'
import { ThemeProvider } from 'next-themes'
import { Toaster } from '@/components/ui/sonner'
import QueryProviders from '@/lib/query/persist'
import { APP_DOMAIN, FOGO_NETWORK, FOGO_ONYC_MINT, USDC_S_MINT } from '@/constants'
import { useSettings } from '@/store/settings'

/* eslint-enable perfectionist/sort-imports */

export default function Providers({ children }: { children: ReactNode }) {
  const { fogoRpcUrl } = useSettings()
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      <QueryProviders>
        <FogoSessionProvider
          key={fogoRpcUrl}
          network={FOGO_NETWORK}
          rpc={fogoRpcUrl}
          domain={APP_DOMAIN}
          tokens={[USDC_S_MINT, FOGO_ONYC_MINT]}
          enableUnlimited
        >
          {children}
          <Toaster richColors closeButton position="bottom-right" />
        </FogoSessionProvider>
      </QueryProviders>
    </ThemeProvider>
  )
}
```

- [ ] **Step 3: Add `suppressHydrationWarning` to `<html>`**

Read `packages/webapp/src/app/layout.tsx`. Add `suppressHydrationWarning` to the `<html>` tag (`next-themes` requires this).

- [ ] **Step 4: Verify dev**

Run: `pnpm --filter @fogo-onre/webapp dev`
Open `http://localhost:3000`. Expected: app renders unchanged. Open DevTools React tab; confirm `ThemeProvider`, `QueryClientProvider`, `Toaster`, `FogoSessionProvider` are mounted.
Stop server.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/providers.tsx packages/webapp/src/app/layout.tsx
git commit -m "feat(webapp): wire shadcn + tanstack providers"
```

---

## Task 7: Rewrite `useBalances` with TanStack Query

**Files:**
- Modify: `packages/webapp/src/hooks/useBalances.ts`

- [ ] **Step 1: Read the current hook**

Read the file. Identify: the underlying RPC call (likely a function in `utils/connections.ts` or `utils/transfer.ts`), the polling interval, and the public return shape (so call sites don't break).

- [ ] **Step 2: Rewrite preserving the public shape**

Pattern to apply:

```ts
import { useQuery } from '@tanstack/react-query'
import { useDocumentVisible } from './useDocumentVisible'
// ... existing imports for the RPC call ...

export function useBalances(/* same args as before */) {
  const visible = useDocumentVisible()
  const ownerB58 = /* ownerPublicKey ? ownerPublicKey.toBase58() : null */
  const mintB58 = /* mintPublicKey.toBase58() */

  return useQuery({
    queryKey: ['balances', ownerB58, mintB58] as const,
    enabled: ownerB58 !== null,
    staleTime: 10_000,
    refetchInterval: visible ? 15_000 : false,
    queryFn: async () => {
      // Call the same underlying RPC function the old hook used.
      // Return the same shape the old hook returned (so call sites work).
    },
  })
}
```

The exact `queryFn` body must call the same RPC helpers the old hook used. Read the old body, copy the RPC call, return its result.

- [ ] **Step 3: Verify call sites compile**

Run: `pnpm --filter @fogo-onre/webapp build`
Expected: build succeeds. If not, the public return shape changed — adjust until it matches.

- [ ] **Step 4: Smoke**

Run: `pnpm --filter @fogo-onre/webapp dev`. Connect a wallet. Confirm balances render in the UI as before. Stop server.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/hooks/useBalances.ts
git commit -m "refactor(webapp): useBalances via tanstack query"
```

---

## Task 8: Rewrite `useOnycPrice`

**Files:**
- Modify: `packages/webapp/src/hooks/useOnycPrice.ts`

- [ ] **Step 1: Read the current hook**

Identify the RPC call (likely `utils/onyc-price.ts`) and return shape.

- [ ] **Step 2: Rewrite**

```ts
import { useQuery } from '@tanstack/react-query'
// ... existing imports ...

export function useOnycPrice(/* same args */) {
  return useQuery({
    queryKey: ['onyc-price'] as const,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      // Call existing onyc-price fetcher; return same shape.
    },
  })
}
```

- [ ] **Step 3: Build, smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp build
git add packages/webapp/src/hooks/useOnycPrice.ts
git commit -m "refactor(webapp): useOnycPrice via tanstack query"
```

---

## Task 9: Rewrite `useProtocolState` with `useSuspenseQuery`

**Files:**
- Modify: `packages/webapp/src/hooks/useProtocolState.ts`

- [ ] **Step 1: Read the current hook.**

- [ ] **Step 2: Rewrite using `useSuspenseQuery`** (so the `Suspense` boundary added in Task 18 actually triggers).

```ts
import { useSuspenseQuery } from '@tanstack/react-query'

export function useProtocolState(/* same args */) {
  return useSuspenseQuery({
    queryKey: ['protocol-state', /* programIdB58 */] as const,
    staleTime: 30_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      // existing protocol-state fetch
    },
  })
}
```

Note: `useSuspenseQuery` always returns `data` (never `undefined`). Adjust call sites that check for `undefined` data — they should now read `data` directly. This may simplify `ProtocolStats.tsx`.

- [ ] **Step 3: Build**

Build will likely error in `ProtocolStats.tsx` because the call site needs an enclosing `<Suspense>`. Wrap the call in `ProtocolStats.tsx` body (or the parent in `page.tsx`) with `<Suspense fallback={<Skeleton …/>}>` before continuing. The full `ProtocolStats` rewrite happens in Task 18 — for now, a temporary `<Suspense fallback={null}>` parent in `page.tsx` around `<ProtocolStats />` is enough to get build green.

- [ ] **Step 4: Smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp dev   # confirm protocol stats still render
git add packages/webapp/src/hooks/useProtocolState.ts packages/webapp/src/app/page.tsx
git commit -m "refactor(webapp): useProtocolState via suspense query"
```

---

## Task 10: Rewrite `useBridgeFee`

**Files:**
- Modify: `packages/webapp/src/hooks/useBridgeFee.ts`

- [ ] **Step 1: Read current hook (uses `lib/bridge/wormholeNttQuote.ts`).**

- [ ] **Step 2: Rewrite**

```ts
import { useQuery } from '@tanstack/react-query'

export function useBridgeFee({
  srcChain, dstChain, mintB58, amountStr,
}: { srcChain: string, dstChain: string, mintB58: string, amountStr: string }) {
  return useQuery({
    queryKey: ['bridge-fee', srcChain, dstChain, mintB58, amountStr] as const,
    staleTime: 30_000,
    enabled: amountStr !== '' && amountStr !== '0',
    queryFn: async () => {
      // existing wormhole NTT quote fetch
    },
  })
}
```

If the current hook accepted different argument types (e.g. `bigint` amounts), convert to string at the call site so the key is string-safe.

- [ ] **Step 3: Build, commit**

```bash
pnpm --filter @fogo-onre/webapp build
git add packages/webapp/src/hooks/useBridgeFee.ts
git commit -m "refactor(webapp): useBridgeFee via tanstack query"
```

---

## Task 11: Rewrite `useFlowStatus`

**Files:**
- Modify: `packages/webapp/src/hooks/useFlowStatus.ts`

- [ ] **Step 1: Read current hook to identify the on-chain `Flow` PDA fetch and the terminal-status discriminator.**

- [ ] **Step 2: Rewrite**

```ts
import { useQuery } from '@tanstack/react-query'

const TERMINAL_STATUSES = ['terminal-success', 'terminal-failure'] as const

export function useFlowStatus(flowId: string | null) {
  return useQuery({
    queryKey: ['flow-status', flowId] as const,
    enabled: flowId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status && TERMINAL_STATUSES.includes(status as any) ? false : 5_000
    },
    staleTime: ({ state }) =>
      state.data?.status && TERMINAL_STATUSES.includes(state.data.status as any)
        ? Infinity
        : 5_000,
    queryFn: async () => {
      // existing flow-pda fetch; return the PersistedFlowStatus shape from Task 12 once it exists
    },
  })
}
```

The full payload shape is defined in Task 12; for this task, return at minimum `{ status, lastPolledAt: Date.now() }` plus whatever fields the existing hook already returned.

- [ ] **Step 3: Build, commit**

```bash
pnpm --filter @fogo-onre/webapp build
git add packages/webapp/src/hooks/useFlowStatus.ts
git commit -m "refactor(webapp): useFlowStatus via tanstack query"
```

---

## Task 12: `PersistedFlowStatus` types and helpers

**Files:**
- Create: `packages/webapp/src/lib/flow-status/types.ts`
- Create: `packages/webapp/src/lib/flow-status/store.ts`

- [ ] **Step 1: Write types**

```ts
// packages/webapp/src/lib/flow-status/types.ts
export type FlowStatusValue =
  | 'pending'
  | 'in-progress'
  | 'terminal-success'
  | 'terminal-failure'

export type FlowKind = 'deposit' | 'withdraw'

export interface PersistedFlowStatus {
  flowId: string
  kind: FlowKind
  signature: string
  ownerB58: string
  mintB58: string
  amountStr: string
  startedAt: number
  baselineDestBalanceStr: string
  status: FlowStatusValue
  notified: boolean
  lastPolledAt: number
}

export const TERMINAL_STATUSES: ReadonlySet<FlowStatusValue> =
  new Set(['terminal-success', 'terminal-failure'])

export function isTerminal(s: FlowStatusValue): boolean {
  return TERMINAL_STATUSES.has(s)
}
```

- [ ] **Step 2: Write the cache helpers**

```ts
// packages/webapp/src/lib/flow-status/store.ts
import type { QueryClient } from '@tanstack/react-query'
import type { PersistedFlowStatus } from './types'

const FLOW_KEY = (id: string) => ['flow-status', id] as const
const INDEX_KEY = ['pending-flow-ids'] as const

export function readIndex(qc: QueryClient): string[] {
  return qc.getQueryData<string[]>(INDEX_KEY) ?? []
}

export function writeIndex(qc: QueryClient, ids: string[]) {
  qc.setQueryData<string[]>(INDEX_KEY, ids)
}

export function addFlow(qc: QueryClient, status: PersistedFlowStatus) {
  qc.setQueryData<PersistedFlowStatus>(FLOW_KEY(status.flowId), status)
  const ids = readIndex(qc)
  if (!ids.includes(status.flowId)) {
    writeIndex(qc, [...ids, status.flowId])
  }
}

export function readFlow(qc: QueryClient, id: string): PersistedFlowStatus | undefined {
  return qc.getQueryData<PersistedFlowStatus>(FLOW_KEY(id))
}

export function patchFlow(
  qc: QueryClient,
  id: string,
  patch: Partial<PersistedFlowStatus>,
) {
  const prev = readFlow(qc, id)
  if (!prev) {
    return
  }
  qc.setQueryData<PersistedFlowStatus>(FLOW_KEY(id), { ...prev, ...patch })
}

export function pendingWithdrawExists(qc: QueryClient): boolean {
  for (const id of readIndex(qc)) {
    const f = readFlow(qc, id)
    if (f && f.kind === 'withdraw' && f.status !== 'terminal-success' && f.status !== 'terminal-failure') {
      return true
    }
  }
  return false
}
```

- [ ] **Step 3: Initialize the index query at startup**

In `packages/webapp/src/lib/query/persist.tsx`, after the `getQueryClient()` call, ensure `['pending-flow-ids']` has a default `[]` value if undefined:

```ts
if (queryClient.getQueryData(['pending-flow-ids']) === undefined) {
  queryClient.setQueryData<string[]>(['pending-flow-ids'], [])
}
```

- [ ] **Step 4: Build, commit**

```bash
pnpm --filter @fogo-onre/webapp build
git add packages/webapp/src/lib/flow-status packages/webapp/src/lib/query/persist.tsx
git commit -m "feat(webapp): persisted flow-status types and helpers"
```

---

## Task 13: Transfer form zod schema

**Files:**
- Create: `packages/webapp/src/lib/forms/transfer-schema.ts`

- [ ] **Step 1: Write the schema**

```ts
import { z } from 'zod'

export interface TransferSchemaContext {
  /** Maximum balance as a base-unit decimal string. */
  maxAmountStr: string
  /** Number of token decimals. */
  decimals: number
}

export function makeTransferSchema({ maxAmountStr, decimals }: TransferSchemaContext) {
  return z.object({
    amount: z
      .string()
      .min(1, 'Required')
      .refine(v => /^\d+(\.\d+)?$/.test(v), 'Invalid number')
      .refine((v) => {
        const dotIdx = v.indexOf('.')
        return dotIdx === -1 || v.length - dotIdx - 1 <= decimals
      }, `Max ${decimals} decimals`)
      .refine(v => Number(v) > 0, 'Must be > 0')
      .refine((v) => {
        // String-compare base-unit equivalents to avoid float coercion.
        // Uses BigInt parsing on `<digits-without-dot>` padded by `decimals`.
        const norm = (s: string) => {
          const [w, f = ''] = s.split('.')
          return BigInt(w + f.padEnd(decimals, '0').slice(0, decimals))
        }
        return norm(v) <= norm(maxAmountStr)
      }, 'Exceeds balance'),
  })
}

export type TransferFormValues = z.infer<ReturnType<typeof makeTransferSchema>>
```

- [ ] **Step 2: Build, commit**

```bash
pnpm --filter @fogo-onre/webapp build
git add packages/webapp/src/lib/forms/transfer-schema.ts
git commit -m "feat(webapp): transfer form zod schema"
```

---

## Task 14: Submit mutation hook

**Files:**
- Create: `packages/webapp/src/hooks/useTransferMutation.ts`

- [ ] **Step 1: Read existing submit logic**

Read the current `TransferCard.tsx` and `useFogoNttTransfer.ts`. Identify:
- The wallet-adapter hook that returns `publicKey`, `signTransaction`/`sendTransaction`.
- The bridge instruction builder calls (`buildFogoNttDepositIx` / `buildFogoNttWithdrawIx`).
- The fee fetch.
- The flow-id derivation.

- [ ] **Step 2: Write the hook**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { addFlow, pendingWithdrawExists } from '@/lib/flow-status/store'
import type { FlowKind, PersistedFlowStatus } from '@/lib/flow-status/types'
// import { useFogoSession or equivalent } from '@fogo/sessions-sdk-react'
// import buildFogoNttDepositIx, buildFogoNttWithdrawIx, fee fetcher, etc.

interface SubmitArgs {
  kind: FlowKind
  amountStr: string
  decimals: number
  mintB58: string
  destOwnerB58: string
  destMintB58: string
}

export function useTransferMutation() {
  const qc = useQueryClient()
  // const session = useFogoSession()  // adjust to actual hook name

  return useMutation({
    mutationFn: async (args: SubmitArgs): Promise<PersistedFlowStatus> => {
      // 1. cheap pre-checks
      if (/* publicKey == null */ false) {
        throw new Error('Wallet not connected')
      }
      if (args.kind === 'withdraw' && pendingWithdrawExists(qc)) {
        throw new Error('Withdraw already in flight')
      }

      // 2. capture destination baseline before signing
      const baselineDestBalanceStr = await /* fetchBalance(args.destOwnerB58, args.destMintB58) */ '0'

      // 3. fee quote (one-shot)
      const fee = await qc.fetchQuery({
        queryKey: ['bridge-fee', /* … */] as const,
        queryFn: async () => /* wormhole quote */ ({}),
      })

      // 4. build ix
      const ix = args.kind === 'deposit'
        ? /* buildFogoNttDepositIx(...) */ null
        : /* buildFogoNttWithdrawIx(...) */ null

      // 5. send via wallet adapter
      const signature = await /* session.sendTransaction(ix) */ ''

      // 6. derive flow id (existing helper) and persist
      const flowId = /* derive from signature / inputs */ ''
      const persisted: PersistedFlowStatus = {
        flowId,
        kind: args.kind,
        signature,
        ownerB58: /* publicKey.toBase58() */ '',
        mintB58: args.mintB58,
        amountStr: args.amountStr,
        startedAt: Date.now(),
        baselineDestBalanceStr,
        status: 'pending',
        notified: false,
        lastPolledAt: 0,
      }
      addFlow(qc, persisted)
      return persisted
    },
    onSuccess: (status) => {
      toast.success(
        status.kind === 'deposit' ? 'Deposit submitted' : 'Withdraw submitted',
        { id: status.flowId, description: `Tx ${status.signature.slice(0, 8)}…` },
      )
    },
    onError: (err) => {
      toast.error('Transaction failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    },
  })
}
```

The skeleton above must be filled with the actual wallet-adapter hook (`@fogo/sessions-sdk-react` exposes `useSession` or similar — read its types) and the actual bridge ix builders.

- [ ] **Step 3: Build, commit**

```bash
pnpm --filter @fogo-onre/webapp build
git add packages/webapp/src/hooks/useTransferMutation.ts
git commit -m "feat(webapp): transfer submit mutation"
```

---

## Task 15: Rewrite `TransferCard` with shadcn `Form`

**Files:**
- Rewrite: `packages/webapp/src/components/TransferCard.tsx`
- Delete (after this task): `packages/webapp/src/components/AmountInput.tsx`, `packages/webapp/src/components/ReceiveField.tsx`, `packages/webapp/src/components/SymbolPill.tsx`

- [ ] **Step 1: Read the current `TransferCard.tsx`**

Identify: input fields, current submit handler (will be replaced by `useTransferMutation`), display of receive amount, display of fees, max-balance shortcut.

- [ ] **Step 2: Write the rewrite**

```tsx
'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useBalances } from '@/hooks/useBalances'
import { useBridgeFee } from '@/hooks/useBridgeFee'
import { useTransferMutation } from '@/hooks/useTransferMutation'
import { makeTransferSchema, type TransferFormValues } from '@/lib/forms/transfer-schema'
// import constants for mint addresses, decimals, symbols

interface Props {
  kind: 'deposit' | 'withdraw'
}

export default function TransferCard({ kind }: Props) {
  const { srcMintB58, dstMintB58, srcSymbol, dstSymbol, decimals } = configFor(kind)
  const balanceQuery = useBalances(/* args derived from kind */)
  const maxAmountStr = balanceQuery.data?.amountStr ?? '0'

  const form = useForm<TransferFormValues>({
    resolver: zodResolver(makeTransferSchema({ maxAmountStr, decimals })),
    mode: 'onChange',
    defaultValues: { amount: '' },
  })

  const amount = form.watch('amount')
  const feeQuery = useBridgeFee({
    srcChain: 'fogo', dstChain: 'solana',
    mintB58: srcMintB58, amountStr: amount,
  })
  const submit = useTransferMutation()

  function onSubmit(values: TransferFormValues) {
    submit.mutate({
      kind,
      amountStr: values.amount,
      decimals,
      mintB58: srcMintB58,
      destOwnerB58: /* derive */ '',
      destMintB58: dstMintB58,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{kind === 'deposit' ? 'Deposit' : 'Withdraw'}</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>Amount</FormLabel>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => form.setValue('amount', maxAmountStr, { shouldValidate: true })}
                    >
                      Max: {maxAmountStr}
                    </button>
                  </div>
                  <FormControl>
                    <div className="relative">
                      <Input inputMode="decimal" placeholder="0.0" {...field} />
                      <Badge variant="secondary" className="absolute right-2 top-1/2 -translate-y-1/2">
                        {srcSymbol}
                      </Badge>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="rounded-md border p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">You receive</span>
                <span>
                  {feeQuery.data?.outputAmountStr ?? '—'} <Badge variant="secondary">{dstSymbol}</Badge>
                </span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-muted-foreground">Bridge fee</span>
                <span>{feeQuery.data?.feeStr ?? '—'}</span>
              </div>
            </div>

            <Button
              type="submit"
              size="lg"
              disabled={!form.formState.isValid || submit.isPending || feeQuery.isLoading}
            >
              {submit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {kind === 'deposit' ? 'Deposit' : 'Withdraw'}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function configFor(kind: 'deposit' | 'withdraw') {
  // Read constants from src/constants.ts and return the correct mints/symbols/decimals.
  // ... fill in with real values from constants.ts ...
  return { srcMintB58: '', dstMintB58: '', srcSymbol: '', dstSymbol: '', decimals: 6 }
}
```

The `configFor` helper must be filled with actual values from `src/constants.ts`. The `feeQuery.data?.outputAmountStr` and `feeStr` must match the field names returned by `useBridgeFee`.

- [ ] **Step 3: Delete dead components**

```bash
rm packages/webapp/src/components/AmountInput.tsx
rm packages/webapp/src/components/ReceiveField.tsx
rm packages/webapp/src/components/SymbolPill.tsx
```

- [ ] **Step 4: Build, smoke**

```bash
pnpm --filter @fogo-onre/webapp build
pnpm --filter @fogo-onre/webapp dev
```
Verify deposit and withdraw forms render, validate (typing `abc` → error, typing `999999` → exceeds-balance error), and that the submit button correctly disables on invalid input. Stop server.

- [ ] **Step 5: Commit**

```bash
git add packages/webapp/src/components/TransferCard.tsx
git rm packages/webapp/src/components/AmountInput.tsx packages/webapp/src/components/ReceiveField.tsx packages/webapp/src/components/SymbolPill.tsx
git commit -m "refactor(webapp): TransferCard via shadcn form + zod"
```

---

## Task 16: Rewrite `PendingTxList`

**Files:**
- Rewrite: `packages/webapp/src/components/PendingTxList.tsx`
- Delete: `packages/webapp/src/store/pending-txs.ts`

- [ ] **Step 1: Read the current `PendingTxList.tsx`**

Identify the rendering shape (list of rows with tx info, status badge, explorer link) so the rewrite preserves comparable UX.

- [ ] **Step 2: Rewrite**

```tsx
'use client'

import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useIsRestoring } from '@tanstack/react-query-persist-client'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { useEffect } from 'react'
import { toast } from 'sonner'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'
import { isTerminal } from '@/lib/flow-status/types'
import { patchFlow } from '@/lib/flow-status/store'
import { useFlowStatus } from '@/hooks/useFlowStatus'
import BridgeSteps from '@/components/BridgeSteps'
// explorer link helpers from utils/explorers.ts

export default function PendingTxList() {
  const restoring = useIsRestoring()
  const idsQuery = useQuery<string[]>({
    queryKey: ['pending-flow-ids'],
    queryFn: async () => [],
    staleTime: Infinity,
    initialData: [],
  })
  const ids = idsQuery.data ?? []

  if (restoring) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    )
  }

  if (ids.length === 0) {
    return (
      <Alert>
        <AlertTitle>No recent transactions</AlertTitle>
        <AlertDescription>
          Your in-flight bridge transfers will appear here.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {ids.map(id => <PendingRow key={id} flowId={id} />)}
    </div>
  )
}

function PendingRow({ flowId }: { flowId: string }) {
  const qc = useQueryClient()
  const persisted = qc.getQueryData<PersistedFlowStatus>(['flow-status', flowId])
  const flow = useFlowStatus(flowId)

  // Notify-once on terminal transition.
  useEffect(() => {
    const live = flow.data
    const stored = qc.getQueryData<PersistedFlowStatus>(['flow-status', flowId])
    if (!live || !stored) return
    if (isTerminal(live.status) && !stored.notified) {
      patchFlow(qc, flowId, { status: live.status, notified: true })
      if (live.status === 'terminal-success') {
        toast.success(stored.kind === 'deposit' ? 'Deposit complete' : 'Withdraw complete', {
          id: flowId,
        })
      } else {
        toast.error('Transfer failed', { id: flowId })
      }
    }
  }, [flow.data?.status, flowId, qc])

  if (!persisted) {
    return null
  }

  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {persisted.kind === 'deposit' ? 'Deposit' : 'Withdraw'} {persisted.amountStr}
          </span>
          <Badge variant={badgeVariant(persisted.status)}>{labelFor(persisted.status)}</Badge>
        </div>
        <BridgeSteps kind={persisted.kind} status={persisted.status} />
        <a
          className="text-xs text-muted-foreground hover:underline"
          href={/* explorer link from utils/explorers.ts */ '#'}
          target="_blank" rel="noreferrer"
        >
          View on explorer
        </a>
      </CardContent>
    </Card>
  )
}

function badgeVariant(s: PersistedFlowStatus['status']): 'default' | 'secondary' | 'destructive' {
  if (s === 'terminal-success') return 'default'
  if (s === 'terminal-failure') return 'destructive'
  return 'secondary'
}

function labelFor(s: PersistedFlowStatus['status']): string {
  if (s === 'pending') return 'Pending'
  if (s === 'in-progress') return 'In progress'
  if (s === 'terminal-success') return 'Complete'
  return 'Failed'
}
```

`BridgeSteps` is implemented in Task 19. For now, render `null` from a stub so this builds.

- [ ] **Step 3: Stub `BridgeSteps`**

Create `packages/webapp/src/components/BridgeSteps.tsx`:

```tsx
export default function BridgeSteps(_: { kind: string, status: string }) {
  return null
}
```

- [ ] **Step 4: Delete the pending-txs store**

```bash
rm packages/webapp/src/store/pending-txs.ts
```

Find all imports of it and remove them:

```bash
grep -rn "store/pending-txs" packages/webapp/src
```

Each match must be removed. The submit-mutation already writes to the QueryClient instead.

- [ ] **Step 5: Build, smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp build
pnpm --filter @fogo-onre/webapp dev
# Confirm "No recent transactions" alert renders. Submit a deposit on devnet → row appears.
git add packages/webapp/src/components/PendingTxList.tsx packages/webapp/src/components/BridgeSteps.tsx
git rm packages/webapp/src/store/pending-txs.ts
git commit -m "refactor(webapp): PendingTxList via persisted queries"
```

---

## Task 17: Replace toasts with sonner

**Files:**
- Delete: `packages/webapp/src/components/ToastHost.tsx`, `packages/webapp/src/store/toasts.ts`
- Modify: every call site of the old toast API.

- [ ] **Step 1: Find call sites**

```bash
grep -rn "from '@/store/toasts'" packages/webapp/src
grep -rn "ToastHost" packages/webapp/src
grep -rn "pushToast" packages/webapp/src
```

- [ ] **Step 2: Replace each call**

Mapping:
- `pushToast({ kind: 'success', ... })` → `toast.success(message, { description })`
- `pushToast({ kind: 'error', ... })` → `toast.error(message, { description })`
- `pushToast({ kind: 'warning', ... })` → `toast.warning(message, { description })`
- `pushToast({ kind: 'info', ... })` → `toast.message(message, { description })`

Imports: `import { toast } from 'sonner'`.

- [ ] **Step 3: Remove the old API**

```bash
rm packages/webapp/src/components/ToastHost.tsx packages/webapp/src/store/toasts.ts
grep -rn "ToastHost\|pushToast\|store/toasts" packages/webapp/src
```

The grep must return no matches.

- [ ] **Step 4: Remove `<ToastHost />` from `page.tsx`**

Read `packages/webapp/src/app/page.tsx` and delete the `<ToastHost />` line and its import.

- [ ] **Step 5: Build, smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp build
pnpm --filter @fogo-onre/webapp dev
# trigger an error in the form (try a too-large amount and submit-bypass via DevTools) → confirm sonner toast appears bottom-right
git add -A packages/webapp/src
git commit -m "refactor(webapp): replace toast store with sonner"
```

---

## Task 18: Rewrite `ProtocolStats`

**Files:**
- Rewrite: `packages/webapp/src/components/ProtocolStats.tsx`
- Create: `packages/webapp/src/components/Statistic.tsx`

- [ ] **Step 1: Write `Statistic`**

```tsx
import { cn } from '@/lib/utils'

interface Props {
  label: string
  value: string
  hint?: string
  className?: string
}

export default function Statistic({ label, value, hint, className }: Props) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}
```

- [ ] **Step 2: Read existing `ProtocolStats.tsx`** to identify the fields shown (TVL, APR, etc.) and how they map to `useProtocolState` data.

- [ ] **Step 3: Rewrite**

```tsx
'use client'

import { Suspense } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import Statistic from './Statistic'
import { useProtocolState } from '@/hooks/useProtocolState'

export default function ProtocolStats() {
  return (
    <Suspense fallback={<ProtocolStatsSkeleton />}>
      <ProtocolStatsInner />
    </Suspense>
  )
}

function ProtocolStatsInner() {
  const { data } = useProtocolState(/* args */)
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <Card><CardContent className="p-4"><Statistic label="TVL" value={/* data.tvl */ '—'} /></CardContent></Card>
      <Card><CardContent className="p-4"><Statistic label="APR" value={/* data.apr */ '—'} /></CardContent></Card>
      <Card><CardContent className="p-4"><Statistic label="Price" value={/* data.price */ '—'} /></CardContent></Card>
    </div>
  )
}

function ProtocolStatsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {[0, 1, 2].map(i => (
        <Card key={i}><CardContent className="p-4"><Skeleton className="h-12" /></CardContent></Card>
      ))}
    </div>
  )
}
```

Replace the placeholder string values with the actual fields exposed by `useProtocolState().data`. Format functions (e.g. `formatUsd`, `formatPct`) likely exist in `utils/`; reuse them.

- [ ] **Step 4: Remove the temporary `<Suspense fallback={null}>` from `page.tsx`** that was added in Task 9 (the boundary now lives inside `ProtocolStats`).

- [ ] **Step 5: Build, smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp build
pnpm --filter @fogo-onre/webapp dev
# Confirm protocol stats render with skeletons → real values
git add packages/webapp/src/components/ProtocolStats.tsx packages/webapp/src/components/Statistic.tsx packages/webapp/src/app/page.tsx
git commit -m "refactor(webapp): ProtocolStats via shadcn + suspense"
```

---

## Task 19: Implement `BridgeSteps`

**Files:**
- Rewrite: `packages/webapp/src/components/BridgeSteps.tsx`

- [ ] **Step 1: Decide step order per `kind`**

- Deposit: `Bridge → Swap → Lock → Mint`
- Withdraw: `Burn → Unlock → Redeem → Release`

(Adjust labels to match the on-chain instruction names in `src/instructions/`.)

- [ ] **Step 2: Implement**

```tsx
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FlowKind, FlowStatusValue } from '@/lib/flow-status/types'

const DEPOSIT_STEPS = ['Bridge', 'Swap', 'Lock', 'Mint'] as const
const WITHDRAW_STEPS = ['Burn', 'Unlock', 'Redeem', 'Release'] as const

interface Props {
  kind: FlowKind
  status: FlowStatusValue
  /** 0-indexed; -1 = none done yet. Derived from status by the parent if not provided. */
  currentIndex?: number
}

export default function BridgeSteps({ kind, status, currentIndex }: Props) {
  const steps = kind === 'deposit' ? DEPOSIT_STEPS : WITHDRAW_STEPS
  const idx = currentIndex ?? deriveIndex(status, steps.length)

  return (
    <ol className="flex items-center gap-2">
      {steps.map((label, i) => {
        const done = i <= idx && status !== 'terminal-failure'
        const failed = status === 'terminal-failure' && i === idx
        return (
          <li key={label} className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border text-[10px]',
                done && 'bg-primary text-primary-foreground border-primary',
                failed && 'bg-destructive text-destructive-foreground border-destructive',
                !done && !failed && 'border-muted-foreground/40 text-muted-foreground',
              )}
            >
              {done ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className={cn(done && 'text-foreground', !done && 'text-muted-foreground')}>{label}</span>
            {i < steps.length - 1 && <span className="h-px w-3 bg-muted-foreground/30" />}
          </li>
        )
      })}
    </ol>
  )
}

function deriveIndex(status: FlowStatusValue, total: number): number {
  if (status === 'pending') return 0
  if (status === 'in-progress') return Math.floor(total / 2)
  if (status === 'terminal-success') return total - 1
  return -1
}
```

For real flow-status mapping, the parent (`PendingRow`) should pass `currentIndex` derived from on-chain status fields rather than relying on `deriveIndex`. Update `PendingTxList`'s `PendingRow` to compute `currentIndex` from the full `useFlowStatus().data`.

- [ ] **Step 3: Build, smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp build
pnpm --filter @fogo-onre/webapp dev
# Submit a deposit → confirm steps render and advance
git add packages/webapp/src/components/BridgeSteps.tsx packages/webapp/src/components/PendingTxList.tsx
git commit -m "feat(webapp): BridgeSteps stepper"
```

---

## Task 20: Rewrite `SettingsDrawer` as `Sheet`

**Files:**
- Rewrite: `packages/webapp/src/components/SettingsDrawer.tsx` → rename file to `SettingsSheet.tsx`

- [ ] **Step 1: Read the existing drawer** for the fields it exposes (`fogoRpcUrl`, slippage, etc.).

- [ ] **Step 2: Rewrite**

```tsx
'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger,
} from '@/components/ui/sheet'
import { Input } from '@/components/ui/input'
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form'
import { Settings } from 'lucide-react'
import { useSettings } from '@/store/settings'

const schema = z.object({
  fogoRpcUrl: z.string().url(),
  // Add other fields from the existing settings store.
})

type Values = z.infer<typeof schema>

export default function SettingsSheet() {
  const { fogoRpcUrl, setFogoRpcUrl /* + other setters */ } = useSettings()
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { fogoRpcUrl },
  })

  function onSubmit(values: Values) {
    setFogoRpcUrl(values.fogoRpcUrl)
    // Other setters as needed.
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Settings"><Settings className="h-5 w-5" /></Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>RPC and protocol parameters.</SheetDescription>
        </SheetHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="mt-4 flex flex-col gap-4">
            <FormField
              control={form.control}
              name="fogoRpcUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>FOGO RPC URL</FormLabel>
                  <FormControl><Input {...field} /></FormControl>
                  <FormDescription>Used by the wallet adapter.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <SheetFooter>
              <Button type="submit">Save</Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 3: Make it dynamic-imported in `Header.tsx`**

```ts
import dynamic from 'next/dynamic'
const SettingsSheet = dynamic(() => import('./SettingsSheet'), { ssr: false })
```

- [ ] **Step 4: Update `Header.tsx`'s import** from `SettingsDrawer` to `SettingsSheet`.

- [ ] **Step 5: Build, smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp build
pnpm --filter @fogo-onre/webapp dev
# Click settings icon → sheet opens; change URL → form validates; save → store updates
git rm packages/webapp/src/components/SettingsDrawer.tsx
git add packages/webapp/src/components/SettingsSheet.tsx packages/webapp/src/components/Header.tsx
git commit -m "refactor(webapp): SettingsDrawer -> shadcn Sheet"
```

---

## Task 21: `ThemeToggle`

**Files:**
- Create: `packages/webapp/src/components/ThemeToggle.tsx`
- Modify: `packages/webapp/src/components/Header.tsx`

- [ ] **Step 1: Write the toggle**

```tsx
'use client'

import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export default function ThemeToggle() {
  const { setTheme } = useTheme()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Toggle theme">
          <Sun className="h-5 w-5 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-5 w-5 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme('light')}><Sun className="mr-2 h-4 w-4" />Light</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('dark')}><Moon className="mr-2 h-4 w-4" />Dark</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme('system')}><Monitor className="mr-2 h-4 w-4" />System</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

- [ ] **Step 2: Add to `Header.tsx`** next to the settings icon.

- [ ] **Step 3: Smoke**

Run dev. Click toggle → switches between light/dark/system. Persists across reload (`next-themes` uses its own localStorage key).

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/src/components/ThemeToggle.tsx packages/webapp/src/components/Header.tsx
git commit -m "feat(webapp): light/dark/system theme toggle"
```

---

## Task 22: Rewrite `WalletButton` for `@fogo/sessions-sdk-react`

**Files:**
- Create: `packages/webapp/src/components/WalletButton.tsx`
- Modify: `packages/webapp/src/components/Header.tsx`

- [ ] **Step 1: Find the right hook**

```bash
grep -rn "from '@fogo/sessions-sdk-react'" packages/webapp/src
```

Identify the hook(s) the existing code uses to read connection state and address (something like `useFogoSession` or `useConnectedWallet`). Read its signature in `node_modules/@fogo/sessions-sdk-react/dist/*.d.ts` if needed.

- [ ] **Step 2: Write the button**

```tsx
'use client'

import { Wallet, LogOut, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
// import the actual fogo-sessions hooks here

export default function WalletButton() {
  // const { connect, disconnect, address, status } = useFogoSession()
  const address: string | null = null   // replace with real
  const isConnected = address !== null

  if (!isConnected) {
    return (
      <Button onClick={() => /* connect() */ {}} size="sm">
        <Wallet className="mr-2 h-4 w-4" />Connect
      </Button>
    )
  }

  const short = `${address!.slice(0, 4)}…${address!.slice(-4)}`

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">{short}</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => {
          navigator.clipboard.writeText(address!)
          toast.success('Address copied')
        }}>
          <Copy className="mr-2 h-4 w-4" />Copy address
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => /* disconnect() */ {}}>
          <LogOut className="mr-2 h-4 w-4" />Disconnect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

Fill in the actual fogo-sessions hook calls. The existing `Header.tsx` already uses these hooks — copy that integration verbatim.

- [ ] **Step 3: Replace the existing wallet UI in `Header.tsx`** with `<WalletButton />`.

- [ ] **Step 4: Smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp dev
# Confirm connect/disconnect, address shown, copy works
git add packages/webapp/src/components/WalletButton.tsx packages/webapp/src/components/Header.tsx
git commit -m "feat(webapp): WalletButton via shadcn"
```

---

## Task 23: Rewrite `Header` and `page.tsx` chrome

**Files:**
- Modify: `packages/webapp/src/components/Header.tsx`
- Modify: `packages/webapp/src/app/page.tsx`

- [ ] **Step 1: Header**

Replace the hand-rolled markup with shadcn primitives + Tailwind:

```tsx
'use client'

import dynamic from 'next/dynamic'
import WalletButton from './WalletButton'
import ThemeToggle from './ThemeToggle'

const SettingsSheet = dynamic(() => import('./SettingsSheet'), { ssr: false })

export default function Header() {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-screen-md items-center justify-between px-4 py-3">
        <div className="font-semibold tracking-tight">FOGO OnRe</div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <SettingsSheet />
          <WalletButton />
        </div>
      </div>
    </header>
  )
}
```

- [ ] **Step 2: `page.tsx` Tabs**

Replace the hand-rolled `Tabs`/`TabButton` with shadcn `Tabs`:

```tsx
'use client'

import { ErrorBoundary } from '@/components/ErrorBoundary'
import Header from '@/components/Header'
import PendingTxList from '@/components/PendingTxList'
import ProtocolStats from '@/components/ProtocolStats'
import TransferCard from '@/components/TransferCard'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export default function Page() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-12 sm:px-6">
        <div className="mx-auto flex max-w-md flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Yield from OnRe</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Deposit USDC.s on FOGO and earn yield backed by real-world reinsurance premiums.
            </p>
          </div>
          <ErrorBoundary label="protocol stats"><ProtocolStats /></ErrorBoundary>
          <Tabs defaultValue="deposit">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="deposit">Deposit</TabsTrigger>
              <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
            </TabsList>
            <TabsContent value="deposit">
              <ErrorBoundary label="deposit"><TransferCard kind="deposit" /></ErrorBoundary>
            </TabsContent>
            <TabsContent value="withdraw">
              <ErrorBoundary label="withdraw"><TransferCard kind="withdraw" /></ErrorBoundary>
            </TabsContent>
          </Tabs>
          <ErrorBoundary label="recent transactions"><PendingTxList /></ErrorBoundary>
        </div>
      </main>
      <footer className="border-t px-4 py-4 text-xs text-muted-foreground sm:px-6">
        <nav aria-label="Footer" className="mx-auto flex max-w-md flex-wrap items-center justify-center gap-x-5 gap-y-1">
          <FooterLink href="https://onre.finance">OnRe</FooterLink>
          <FooterLink href="https://docs.onre.finance/technical-resources/token-configuration-and-reference">OnRe Docs</FooterLink>
          <FooterLink href="https://app.onre.finance/earn/transparency">Transparency</FooterLink>
          <FooterLink href="https://github.com/pointgroup-labs/fogo-onre">GitHub</FooterLink>
          <FooterLink href="https://github.com/pointgroup-labs/fogo-onre/blob/main/docs/security.md">Security</FooterLink>
        </nav>
      </footer>
    </div>
  )
}

function FooterLink({ href, children }: { href: string, children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-muted-foreground transition-colors hover:text-foreground">
      {children}
    </a>
  )
}
```

- [ ] **Step 3: Update `ErrorBoundary` fallback** to use shadcn `Alert`:

```tsx
// packages/webapp/src/components/ErrorBoundary.tsx render fallback:
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

// inside the fallback render path:
<Alert variant="destructive">
  <AlertTitle>Something went wrong in {label}</AlertTitle>
  <AlertDescription>{error?.message ?? 'Unknown error'}</AlertDescription>
  <Button className="mt-2" size="sm" variant="outline" onClick={resetErrorState}>Reload</Button>
</Alert>
```

(Keep the class component / hook structure that already exists; only the fallback markup changes.)

- [ ] **Step 4: Build, smoke, commit**

```bash
pnpm --filter @fogo-onre/webapp build
pnpm --filter @fogo-onre/webapp dev
# Full visual smoke: header, tabs, transfer card, pending list, footer
git add -A packages/webapp/src
git commit -m "refactor(webapp): page chrome via shadcn primitives"
```

---

## Task 24: Bundle pass

**Files:**
- Modify: `packages/webapp/next.config.ts`

- [ ] **Step 1: Add `optimizePackageImports`**

```ts
// next.config.ts — merge into the existing config object
const nextConfig = {
  // ... existing config ...
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
}
```

- [ ] **Step 2: Production build**

```bash
pnpm --filter @fogo-onre/webapp build
```

Expected: build succeeds. Note the route's first-load JS in the build output.

- [ ] **Step 3: Confirm `SettingsSheet` is dynamic**

Check the build output for a separate chunk for `SettingsSheet`. If it's bundled into the main chunk, re-verify the `dynamic()` import in `Header.tsx`.

- [ ] **Step 4: Commit**

```bash
git add packages/webapp/next.config.ts
git commit -m "perf(webapp): optimizePackageImports for lucide-react"
```

---

## Task 25: Cleanup

**Files:** (depend on grep findings)

- [ ] **Step 1: Find unused exports**

```bash
pnpm --filter @fogo-onre/webapp exec tsc --noEmit
grep -rn "import .* from '@/store/toasts'\|import .* from '@/store/pending-txs'\|import .* from '@/components/SymbolPill'\|import .* from '@/components/AmountInput'\|import .* from '@/components/ReceiveField'\|import .* from '@/components/ToastHost'\|import .* from '@/components/SettingsDrawer'" packages/webapp/src
```

The grep must return no matches. Any remaining import is a leftover; delete it.

- [ ] **Step 2: Lint**

```bash
pnpm --filter @fogo-onre/webapp lint --fix || true
pnpm --filter @fogo-onre/webapp lint
```

Fix any reported issues.

- [ ] **Step 3: Final build**

```bash
pnpm --filter @fogo-onre/webapp build
```

- [ ] **Step 4: Smoke checklist (from spec § Validation V1)**

Run the dev server and confirm every box on the spec's checklist.

- [ ] **Step 5: Commit**

```bash
git add -A packages/webapp/src
git commit -m "chore(webapp): cleanup imports and lint" || echo "nothing to clean"
```

---

## Task 26: Open PR

- [ ] **Step 1: Push**

```bash
git push -u origin refactor/webapp-shadcn
```

- [ ] **Step 2: PR body**

Title: `refactor(webapp): migrate to shadcn/ui + tanstack query`

Body should reference the spec at `docs/superpowers/specs/2026-05-09-webapp-shadcn-refactor-design.md` and the smoke checklist from § Validation V1.

---

## Self-Review Notes

**Spec coverage:** Every section of the spec maps to at least one task —
architecture (T1–T6), component map (T15, T16, T18, T20, T21, T22, T23),
data flow (T7–T14), error handling (T17, T23 step 3), implementation
order (matches the spec's 9 steps modulo the merged tasks the spec
itself called for), validation (T25 step 4).

**Type consistency:** `PersistedFlowStatus` defined once in T12 and
referenced verbatim by T14, T16, T19. Query keys (`['flow-status', id]`,
`['pending-flow-ids']`) consistent across T11, T12, T14, T16. Status
values (`pending` / `in-progress` / `terminal-success` /
`terminal-failure`) consistent across T11, T12, T16, T19.

**Known plan limitations** (acceptable per the V1 validation posture
and the existence of executor reads at run time):
- Tasks 7–11 (hook rewrites) instruct the executor to read the
  current hook before rewriting. Full code is given as a pattern,
  but the `queryFn` body is filled in from the existing
  implementation. This is intentional: the existing RPC code is
  load-bearing and the spec forbids changing its semantics.
- Task 14 (`useTransferMutation`) leaves wallet-adapter hook calls
  as `// existing` placeholders the executor fills from the current
  `TransferCard.tsx` and `useFogoNttTransfer.ts`. Same reason.
- Task 22 (`WalletButton`) ditto for the fogo-sessions hooks.
- Task 18 (`ProtocolStats`) leaves the actual stat names (TVL/APR/
  Price) as best-guesses — the executor must read
  `useProtocolState`'s data shape and substitute correctly.
