# Webapp Refactor: shadcn/ui + Tailwind + TanStack Query (C2 + D2)

**Date:** 2026-05-09
**Scope:** `packages/webapp/` only
**Status:** Design — pending user approval (revised: framework switched from antd to shadcn/ui after codex CLI review and user direction)

## Goal

Refactor the FOGO OnRe webapp to use **shadcn/ui** (Radix primitives +
Tailwind, components copied into the repo) as the component layer
and **TanStack Query 5** as the data layer. Preserve bridge logic
semantically; modernize everything around it. Improve UX with
purpose-fit components (custom `BridgeSteps` for bridge progress,
`react-hook-form` + `zod` for the transfer card, `sonner` for async
notifications). Keep Tailwind. Drop the bespoke Zustand toast and
pending-tx stores.

## Non-Goals

- No changes to the Solana program or third-party CPI bindings.
- No changes to `packages/sdk/`.
- No semantic changes to `src/constants.ts`, `src/utils/transfer.ts`,
  or `src/lib/bridge/*` (call sites adjust; internals do not).
- No new tests, Storybook, Playwright, or i18n.
- No changes to wallet-adapter selection.

## Decisions Recap

- **Scope:** Option C (full architectural refactor), variant **C2**
  (refactor + UX polish, behavior-preserving for bridge calls).
- **Framework:** Option **F2** — shadcn/ui + Tailwind + Radix (chosen
  over antd for bundle, aesthetic, React 19 ergonomics, and DeFi
  ecosystem alignment).
- **Data layer:** Option **D2** — TanStack Query replaces the
  hand-rolled fetching hooks; pending-tx state collapses into
  persisted queries; `settings` Zustand store stays; `toasts` store
  is deleted.
- **Validation:** Option **V1** — manual devnet smoke test, no new
  automated tests.
- **Tailwind:** **stays.** shadcn is Tailwind-native.
- **Theme:** light/dark/system via `next-themes`, default dark.
  `colorPrimary` (CSS variable `--primary`) defaults to indigo
  (`hsl(238 81% 60%)`) — **placeholder, override pre-merge if a real
  brand color is preferred.**

## Architecture

### Dependency changes

Added (webapp only):
- `tailwindcss-animate` (shadcn animation utilities)
- `class-variance-authority` (shadcn variant API)
- `clsx`, `tailwind-merge` (shadcn `cn()` helper)
- `lucide-react` (shadcn's icon set)
- `@radix-ui/*` (auto-pulled by shadcn components as installed)
- `react-hook-form`, `@hookform/resolvers`, `zod` (form layer)
- `sonner` (toast notifications)
- `next-themes` (light/dark toggle without FOUC)
- `@tanstack/react-query@^5`
- `@tanstack/react-query-devtools` (dev only)
- `@tanstack/query-sync-storage-persister`
- `@tanstack/react-query-persist-client`

shadcn itself is *not* an npm dep — components are scaffolded into
`src/components/ui/` via `npx shadcn@latest add <component>`. Initial
add list:
- `button`, `card`, `tabs`, `input`, `label`, `form`, `sheet`,
  `dialog`, `dropdown-menu`, `skeleton`, `alert`, `badge`,
  `scroll-area`, `separator`, `sonner`

Removed:
- `src/components/ToastHost.tsx`
- `src/store/toasts.ts`
- `src/store/pending-txs.ts`

(Tailwind stays.)

### Provider tree

```
<ThemeProvider attribute="class" defaultTheme="dark" enableSystem>  // next-themes
  <QueryClientProviderWrapper>                                       // App Router pattern
    <PersistQueryClientWrapper>                                      // client-only
      <WalletProviders>
        {children}
        <Toaster />                                                  // sonner, portal-rendered
      </WalletProviders>
    </PersistQueryClientWrapper>
  </QueryClientProviderWrapper>
</ThemeProvider>
```

`ThemeProvider` from `next-themes` is the outermost wrapper. It
injects an inline `<script>` (via `attribute="class"` + the package's
internal blocking script) that sets `class="dark"` on `<html>` *before*
hydration, eliminating FOUC for non-default themes — solves the
problem the antd plan could only mitigate.

`QueryClientProviderWrapper` is a `'use client'` component that calls
`getQueryClient()` inside `useState`'s lazy initializer
(`rerender-lazy-state-init`). `getQueryClient()`:
- on the server, returns a fresh `QueryClient` per call;
- on the client, returns a memoized singleton stored on
  `globalThis.__fogoQueryClient`.

`PersistQueryClientWrapper` is mounted only when `typeof window !==
'undefined'` (the `localStoragePersister` is constructed lazily inside
it for the same reason).

### Theme

- `next-themes` with `attribute="class"`, `defaultTheme="dark"`,
  `enableSystem` for the auto/system option.
- Tailwind's `darkMode: 'class'` setting drives the CSS variable
  switch in `globals.css` via `:root` (light) and `.dark` (dark)
  blocks containing the shadcn token variables (`--background`,
  `--foreground`, `--primary`, etc.).
- The `useTheme()` hook from `next-themes` powers the header
  `ThemeToggle` (a shadcn `DropdownMenu`: Light / Dark / System).
- The `settings` Zustand store no longer carries the theme — `next-themes`
  handles persistence via its own `localStorage` key.

### Bundle/perf rules applied

- `bundle-dynamic-imports`: `SettingsSheet` is `next/dynamic`-loaded
  (`{ ssr: false }`); wallet adapter UI stays dynamic as today.
- `server-hoist-static-io`: query defaults (`staleTime`, `retry`)
  defined in a static `defaultOptions` object at module scope.
- `bundle-barrel-imports`: shadcn components are imported directly
  from `@/components/ui/<file>`; lucide icons imported as
  `import { Icon } from 'lucide-react'` (already optimized; pinned
  in `optimizePackageImports` in `next.config.ts` if bundle analysis
  shows regression).

## Component Map

| Today | Fate | New form |
|---|---|---|
| `app/page.tsx` | rewrite | shadcn `Tabs` replaces hand-rolled tablist; layout via Tailwind utilities (unchanged paradigm) |
| `app/layout.tsx` | minor | wraps `Providers`; no CSS-in-JS registry needed |
| `providers.tsx` | rewrite | new tree above |
| `Header.tsx` | rewrite | brand left; `ThemeToggle` (`DropdownMenu`) + settings `Button` + `WalletButton` right |
| `TransferCard.tsx` | rewrite | shadcn `Card` + shadcn `Form` (= `react-hook-form` + `zod`) with `FormField` per input; submit `Button` with `loading` derived from mutation state |
| `AmountInput.tsx` | collapse | merged into a `FormField` containing `Input` + a small inline `<Badge>{symbol}</Badge>`; max-balance shortcut becomes adjacent `Button variant="ghost" size="sm"` |
| `ReceiveField.tsx` | collapse | merged into a read-only `FormField` rendered as a `<Statistic>` (custom small component) |
| `SymbolPill.tsx` | replaced | use shadcn `Badge` directly |
| `ProtocolStats.tsx` | rewrite | grid of `Card`s, each containing a small custom `<Statistic>` (label + value + skeleton); wrapped in `Suspense` with `Skeleton` fallback |
| `PendingTxList.tsx` | rewrite | rendered list of `Card` rows; each row shows `BridgeSteps`; empty state is a centered `Alert` |
| `SettingsDrawer.tsx` | rewrite | shadcn `Sheet` + shadcn `Form`; `next/dynamic`-loaded |
| `ToastHost.tsx` | delete | replaced by `sonner` (`<Toaster />` mounted once in providers; calls via `import { toast } from 'sonner'`) |
| `ErrorBoundary.tsx` | keep | fallback rewritten as shadcn `Alert variant="destructive"` + retry `Button` |

New components:
- `src/components/BridgeSteps.tsx` — ~50-line custom component
  implementing horizontal stepper from Tailwind primitives. Single
  source of truth for the flow-status → step-index mapping.
- `src/components/WalletButton.tsx` — wraps wallet-adapter hooks
  (`useWallet`, `useWalletModal`); renders `Button` when disconnected,
  `DropdownMenu` (truncated address + Copy + Disconnect) when
  connected.
- `src/components/ThemeToggle.tsx` — `DropdownMenu` of Light / Dark /
  System, bound to `useTheme()` from `next-themes`.
- `src/components/Statistic.tsx` — small custom (label, value,
  optional change indicator); used in `ProtocolStats`.

### React perf rules baked in

- `rendering-conditional-render`: ternaries instead of `&&` in JSX
  (the same `0 && <X/>` footgun applies in any framework).
- `rerender-no-inline-components`: subcomponents always defined at
  module scope.
- `rerender-defer-reads`: Zustand selectors so components subscribe
  only to slices they read.
- `rerender-derived-state-no-effect`: receive-amount derived during
  render from form input + quote query, never `useEffect`-stored.
- `rerender-lazy-state-init`: function form of `useState` for any
  expensive initial computation (notably `getQueryClient`).
- `async-cheap-condition-before-await`: pre-checks (publicKey,
  amount, withdraw-singleton) run before the first `fetchQuery`.

### Form architecture

`TransferCard` uses `react-hook-form` + `zod` (the shadcn `Form`
wrapper):
- A `zod` schema validates `{ amount: string, recipient?: string }`.
  `amount` is a string with custom refinements: positive, decimals
  ≤ token decimals, ≤ balance. **String-typed throughout** — no
  float coercion, no precision loss for token amounts.
- `useForm({ resolver: zodResolver(schema), mode: 'onChange' })`.
- `form.formState.isValid` drives the submit `Button`'s `disabled`
  prop directly (unlike antd, react-hook-form *does* surface
  validity reactively without ceremony).
- `form.watch('amount')` drives the live receive-amount.
- `form.handleSubmit` runs the submit `useMutation`.

Collapses ~6 `useState`s into one form instance and gets
submit-on-Enter + disabled-while-invalid for free (this time it's
actually free).

## Data Flow

### Query keys

All keys use string-safe primitives only — `PublicKey` becomes
`pubkey.toBase58()`, `bigint`/amounts become decimal strings. No
class instances or `bigint` in keys or persisted payloads.

| Key | `staleTime` | `refetchInterval` | Notes |
|---|---|---|---|
| `['balances', ownerB58, mintB58]` | `10s` | `15s` when tab visible, off when hidden | one query per (wallet, mint); visibility via `useDocumentVisible` in the `refetchInterval` callback |
| `['onyc-price']` | `60s` | `5min` | shared (`client-swr-dedup`) |
| `['protocol-state', programIdB58]` | `30s` | `1min` | feeds `ProtocolStats`; uses `useSuspenseQuery` so the `Suspense` + `Skeleton` boundary actually triggers |
| `['bridge-fee', srcChain, dstChain, mintB58, amountStr]` | `30s` | none | refetched on input change via key |
| `['flow-status', flowId]` | `5s` while non-terminal; `Infinity` once terminal | `5s` while non-terminal | per-pending-tx |
| `['pending-flow-ids']` | `Infinity` | none | persisted index of known flow IDs; the source of truth for `PendingTxList`'s `useQueries`. Mutated via `setQueryData` on submit and on terminal-prune. |

### Persisted flow-status payload

A persisted `['flow-status', flowId]` entry must carry enough state
to (a) render the row without re-fetching anything, and (b) resume
polling correctly after reload:

```ts
type PersistedFlowStatus = {
  flowId: string                 // PDA address (base58)
  kind: 'deposit' | 'withdraw'
  signature: string              // origin tx signature for explorer link
  ownerB58: string               // wallet that initiated
  mintB58: string                // source mint (USDC.s for deposit, ONyc for withdraw)
  amountStr: string              // base-unit amount as decimal string
  startedAt: number              // ms epoch
  baselineDestBalanceStr: string // dest balance captured *before* sign — see Race section
  status: 'pending' | 'in-progress' | 'terminal-success' | 'terminal-failure'
  notified: boolean              // whether the terminal notification has fired
  lastPolledAt: number           // ms epoch
}
```

### Persistence

- `localStoragePersister` keyed `fogo-onre.queries.v1`.
- `dehydrateOptions.shouldDehydrateQuery`: only
  `['flow-status', ...]` and `['pending-flow-ids']` queries persist.
  Balances/prices stay in-memory and refetch on load.
- **No `maxAge` cap.** Stale-but-still-pending entries are kept and
  surfaced with a warning state in the row (computed from
  `Date.now() - startedAt > 24h`). Capping via `maxAge` would silently
  drop them, which contradicts the warning UX.
- Schema versioning per `client-localstorage-schema`: bump the `.v1`
  suffix on the persister key when `PersistedFlowStatus` shape
  changes; old caches are then ignored on load.

### Submit flow (deposit/withdraw)

The submit handler is a `useMutation` so concurrent submits are
locked at the mutation level (TanStack Query's `mutate` is a no-op
while `isPending`). This is the local "double-click / reload race"
guard; the relayer's on-chain mutex remains the real enforcement.

1. `form.handleSubmit` fires with `{ amount, recipient? }` (validated
   by zod); mutation runs.
2. Cheap pre-checks (`async-cheap-condition-before-await`):
   - `publicKey == null` → `toast.error`, abort mutation.
   - amount invalid → defensive abort (zod already caught it).
   - withdraw + non-terminal withdraw flow exists in
     `['pending-flow-ids']` → `toast.warning` "withdraw already in
     flight", abort.
3. **Capture destination baseline** before any signing:
   `baselineDestBalanceStr = await fetchBalance(destOwner, destMint)`.
   Persisting this lets a post-reload poll distinguish "not yet
   delivered" from "delivered before page loaded".
4. `queryClient.fetchQuery({ queryKey: ['bridge-fee', ...], queryFn })`
   — one-shot (`async-defer-await`); v5 object syntax.
5. Build NTT instruction via the SDK
   (`buildFogoNttDepositIx` / `buildFogoNttWithdrawIx`) — semantically
   unchanged.
6. Send via wallet adapter; on signature returned:
   - `setQueryData(['flow-status', flowId], { ...PersistedFlowStatus, status: 'pending', notified: false })`
   - `setQueryData(['pending-flow-ids'], (prev) => [...prev, flowId])`
     — the reactive trigger that makes `PendingTxList` re-render.
7. `toast.success` confirms submission with a "view explorer" action.
8. The per-row `useQuery(['flow-status', flowId])` polls every 5s
   while non-terminal. On observed transition to a terminal status:
   - `setQueryData(['flow-status', flowId], { ..., status, notified: true })`
   - if `notified` was `false` *before* this transition, fire
     `toast.success` (or `toast.error`) with a "view explorer" action.
     The `notified` flag prevents replay on reload — if the flow was
     already terminal-and-notified in localStorage, no toast fires
     on rehydration.
   - polling stops because `staleTime` is `Infinity` once terminal.

### Withdraw singleton guard

Three layers, weakest to strongest:
1. **Mutation-level lock.** The submit `useMutation`'s `isPending`
   blocks rapid double-clicks within a tab.
2. **Cache-level guard.** Submit handler reads
   `['pending-flow-ids']` → checks if any non-terminal
   `['flow-status', id]` entry has `kind === 'withdraw'`; if so,
   `toast.warning` "withdraw already in flight" and abort.
3. **On-chain mutex.** Relayer enforces a singleton
   `RedemptionTracker`. The cache guard is racy across tabs and
   reloads; the on-chain mutex catches what the UI misses. The
   handler treats the relayer's mutex error as expected UX (friendly
   `toast.warning`, no console error spam).

## Error Handling

### Error boundaries

- Existing `ErrorBoundary` retained, fallback rewritten as shadcn
  `Alert variant="destructive"` + reload `Button`.
- Boundaries on: `protocol stats`, the active tab's `TransferCard`,
  `recent transactions`, and the new `WalletButton`.

### Async error sink

- `toast` from `sonner` is the only user-visible async-error sink.
- `toast.error(message, { id, description, action })`. Stable `id`s
  so retries replace prior toasts (sonner's API for this is built-in).
- `formatError(err)` maps known error classes (wallet-adapter
  `WalletSignTransactionError`, RPC errors with codes, NTT-specific
  errors, relayer mutex errors) to friendly messages; unknown falls
  back to `err.message`.

### Query error policy

- `retry: 2` with exponential backoff for read queries.
- `retry: false` for the one-shot `fetchQuery` inside submit.
- `throwOnError: false` everywhere except `useSuspenseQuery` queries
  (which must throw to trigger Suspense/error fallbacks). Plain
  `useQuery` errors surface inline via `query.isError` /
  `query.error` rendered as shadcn `Alert` mini-states — they do
  **not** propagate to `ErrorBoundary`. Render-time errors and
  runtime data errors stay on separate channels.

### Loading states

- `Suspense` + shadcn `Skeleton` for `ProtocolStats` is driven by
  `useSuspenseQuery` (plain `useQuery` does not suspend).
- shadcn `Skeleton` for `TransferCard` while wallet is connecting.
- `Button` `disabled` + spinner icon (`Loader2` from lucide with
  `animate-spin`) for in-flight submits, sourced from
  `mutation.isPending`.
- `PendingTxList` shows `Skeleton` rows while persisted queries
  rehydrate (read from `useIsRestoring()` from
  `@tanstack/react-query-persist-client`).

### SSR / hydration

- No CSS-in-JS registry needed. Tailwind is build-time CSS; shadcn
  components produce static class names. SSR ships a complete
  stylesheet on first paint.
- The app remains client-rendered (`'use client'` on `page.tsx`).
- `next-themes`'s built-in inline script (injected by `<ThemeProvider>`
  with `attribute="class"`) sets `class="dark"` on `<html>` *before*
  React hydrates, so non-default themes do not flash dark first.
- `<html suppressHydrationWarning>` on the root tag in
  `app/layout.tsx` to silence the expected mismatch from the theme
  script (`rendering-hydration-suppress-warning`).

## Implementation Order

Each step keeps the app buildable. **Tailwind stays throughout** —
no rip-out step.

1. **Provider scaffolding.** Add deps; run `npx shadcn@latest init`
   (configures `tailwind.config`, `globals.css` token blocks, and
   `lib/utils.ts` with the `cn()` helper); rewrite `providers.tsx`
   and `app/layout.tsx` with `ThemeProvider`,
   `QueryClientProviderWrapper`, `PersistQueryClientWrapper` (client-
   only), `<Toaster />`. App still renders the old `page.tsx` body.
2. **shadcn component scaffold.** `npx shadcn add button card tabs
   input label form sheet dialog dropdown-menu skeleton alert badge
   scroll-area separator sonner` — populates `src/components/ui/`.
   Nothing else changes yet; this is purely additive.
3. **Hooks → TanStack Query.** Rewrite `useBalances`,
   `useOnycPrice`, `useProtocolState` (`useSuspenseQuery`),
   `useBridgeFee`, `useFlowStatus` to use `useQuery`. RPC internals
   in `utils/transfer.ts` and `lib/bridge/*` untouched. Old hook
   signatures preserved during this step so call sites don't churn.
4. **Combined: pending-tx persistence + `TransferCard` rewrite.**
   Done together because deleting `store/pending-txs.ts` requires
   the new submit handler to write to QueryClient instead. Adds
   `['pending-flow-ids']`, the `PersistedFlowStatus` schema, the
   `useMutation` submit, the baseline-balance capture, the
   notify-once flag. Rewrites `TransferCard` to shadcn `Card` +
   `Form` (`react-hook-form` + `zod`) and drops `AmountInput` /
   `ReceiveField`. Rewrites `PendingTxList` to render a list driven
   by `['pending-flow-ids']`.
5. **Notifications.** Delete `ToastHost` and `store/toasts.ts`;
   replace every `pushToast` call site with `sonner`'s `toast.X`.
6. **Polish.** `BridgeSteps` in `PendingTxList` items;
   `ProtocolStats` rewritten using the custom `Statistic` component
   inside `Card`s with `Suspense` + `Skeleton`; `SettingsDrawer`
   rewritten as shadcn `Sheet` + `Form`, `next/dynamic`-loaded;
   `ThemeToggle` (shadcn `DropdownMenu`) added to `Header`.
7. **Header & layout polish.** Convert `Header` to shadcn primitives
   + Tailwind layout; replace `SymbolPill` usages with shadcn
   `Badge`. Convert hand-rolled `Tabs` in `page.tsx` to shadcn `Tabs`.
8. **Bundle pass.** Confirm `next/dynamic` on `SettingsDrawer` (and
   add for other heavy panels if measurement helps); verify
   `optimizePackageImports` config for `lucide-react` if needed;
   `next build`; review the route's first-load JS for regressions.
9. **Cleanup.** Remove dead exports/CSS; `pnpm lint:fix`. (Skipping
   `pnpm sdk build` — webapp refactor doesn't touch the SDK and
   triggering it would violate the no-`packages/sdk` constraint.)

## Validation (V1)

Manual devnet smoke checklist:

- [ ] App boots; theme toggle (Light/Dark/System) persists across
      reload; no FOUC.
- [ ] Wallet connect/disconnect; address visible in header dropdown.
- [ ] `ProtocolStats` renders real numbers (not skeletons forever).
- [ ] Deposit happy path: zod validation → submit → toast → row
      appears in `PendingTxList` → `BridgeSteps` advances → terminal
      toast with explorer link.
- [ ] Withdraw happy path: same.
- [ ] Withdraw concurrency block: second withdraw rejected with
      "already in flight"; no on-chain call made.
- [ ] Reload mid-flow: persisted `flow-status` keeps row visible and
      resumes polling; terminal toast does *not* replay on reload of
      an already-terminal flow (`notified` flag verified).
- [ ] Wallet rejection during signing: `toast.warning` ("Transaction
      cancelled"); no flow row created.
- [ ] Error boundary: throwing inside `ProtocolStats` renders
      `Alert variant="destructive"`; `TransferCard` keeps working.
- [ ] `next build` succeeds; no console errors on dev server.

## Estimated Diff

- ~17 files modified
- 3 files deleted (`ToastHost.tsx`, `store/toasts.ts`,
  `store/pending-txs.ts`)
- ~4 files added (`BridgeSteps.tsx`, `WalletButton.tsx`,
  `ThemeToggle.tsx`, `Statistic.tsx`)
- ~15 files added under `src/components/ui/` (shadcn-scaffolded;
  owned by the repo, not an npm dep)

## Risks

- **shadcn missing components.** `Steps` and `Statistic` aren't
  shipped. Mitigation: both are small bespoke components built from
  primitives — `BridgeSteps` is ~50 lines, `Statistic` is ~30 lines.
  No risk; just acknowledged scope.
- **`react-hook-form` + `zod` learning curve.** If the team is
  unfamiliar, the form rewrite is the highest-touch step. Mitigation:
  the shadcn docs include a copy-paste pattern that this spec follows
  exactly; deviation is unnecessary.
- **Persistence schema drift.** A future shape change to
  `PersistedFlowStatus` without bumping the `v1` key would
  deserialize stale entries. Mitigation: bump the `.v1` suffix in the
  persister key whenever the schema changes; treat the rehydrated
  cache as advisory and revalidate via the live `flow-status` query.
- **Cross-tab withdraw race.** Cache guard does not lock across tabs.
  Mitigation: rely on the on-chain mutex; render the relayer's mutex
  error as an expected UX state, not a failure.
- **Notify-once on reload.** Without the `notified` flag, terminal
  toasts would replay on every reload of a completed flow. The flag
  is persisted with the rest of the flow status and gated on the
  *transition* (not the value) so legitimate later transitions still
  notify.
- **shadcn upgrade path.** Components are copied, not depended on.
  Future shadcn improvements require manual re-pull or diff. Accepted
  tradeoff for owning the code; this is shadcn's design philosophy.

## What this revision dropped (vs. antd version)

Removed risks/complexity that were specifically antd-shaped:
- React 19 + antd 5 internal-API breakages → gone (no patch needed).
- antd CSS-in-JS SSR registry → gone (Tailwind is build-time CSS).
- SSR theme flash → gone (`next-themes` blocking script handles it).
- Tailwind teardown step → gone (Tailwind stays).
- antd `Form` "disabled-while-invalid" caveat → gone
  (`react-hook-form` exposes validity reactively).
- antd `InputNumber stringMode` precision quirk → gone (zod-validated
  string `<Input>`).
