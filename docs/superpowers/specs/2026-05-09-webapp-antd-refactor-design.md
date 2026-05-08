# Webapp Refactor: antd + TanStack Query (C2 + D2)

**Date:** 2026-05-09
**Scope:** `packages/webapp/` only
**Status:** Design — pending user approval

## Goal

Refactor the FOGO OnRe webapp to use Ant Design 5 as the component
library and TanStack Query 5 as the data layer. Preserve bridge logic
semantically; modernize everything around it. Improve UX with antd
primitives where it's a clear win (Steps for bridge progress, Form for
the transfer card, notification for async errors). Drop the bespoke
Tailwind layout and toast systems.

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
- **Data layer:** Option **D2** — TanStack Query replaces the
  hand-rolled fetching hooks; pending-tx state collapses into a
  persisted `flow-status` query family; `settings` Zustand store
  stays; `toasts` store is deleted.
- **Validation:** Option **V1** — manual devnet smoke test, no new
  automated tests.
- **Tailwind:** Option **T2** — removed. Layout via antd `Layout`,
  `Flex`, `Space`.
- **Theme:** Option **Th3** — light/dark toggle, default dark,
  `colorPrimary: '#6366f1'` (indigo) **as a placeholder you may
  override at review time**.

## Architecture

### Dependency changes

Added (webapp only):
- `antd@^5`
- `@ant-design/nextjs-registry` (App Router CSS-in-JS SSR)
- `@tanstack/react-query@^5`
- `@tanstack/react-query-devtools` (dev only)
- `@tanstack/query-sync-storage-persister`
- `@tanstack/react-query-persist-client`
- `dayjs` (antd peer)

Removed:
- `tailwindcss`, `@tailwindcss/postcss`, postcss config, `tailwind.config.*`,
  `@tailwind` directives in `globals.css`.
- `src/components/ToastHost.tsx`
- `src/store/toasts.ts`
- `src/store/pending-txs.ts`

### Provider tree

```
<AntdRegistry>
  <ConfigProvider theme={...} locale={enUS}>
    <App>
      <PersistQueryClientProvider client={queryClient} persistOptions={...}>
        <WalletProviders>
          {children}
        </WalletProviders>
      </PersistQueryClientProvider>
    </App>
  </ConfigProvider>
</AntdRegistry>
```

The `App` wrapper must enclose every component that calls
`App.useApp()`. `ConfigProvider` is outside `App` so theme tokens
flow into `App`'s portal-rendered notifications/messages.

### Theme

- `algorithm`: `[theme.darkAlgorithm, theme.compactAlgorithm]` by
  default; `[theme.defaultAlgorithm, theme.compactAlgorithm]` when the
  toggle is set to light.
- `token.colorPrimary`: `#6366f1` (placeholder — override pre-merge
  if a real brand color is preferred).
- Persisted via the `settings` Zustand store under key `theme`
  (`'dark' | 'light' | 'auto'`, default `'dark'`).
- An inline `<script>` in `app/layout.tsx` `<head>` reads the
  persisted preference and sets `data-theme` on `<html>` before
  hydration to avoid FOUC (`rendering-hydration-no-flicker`).

### Bundle/perf rules applied

- `bundle-dynamic-imports`: `SettingsDrawer` is `next/dynamic`-loaded
  (`{ ssr: false }`); wallet adapter UI stays dynamic as today.
- `server-hoist-static-io`: `QueryClient` constructed once at module
  scope with default `staleTime`; not per-render.
- `bundle-barrel-imports`: import directly from `'antd'` (antd 5
  tree-shakes); revisit if bundle analysis shows regression.

## Component Map

| Today | Fate | New form |
|---|---|---|
| `app/page.tsx` | rewrite | `Layout.Header`/`Content`/`Footer`; `Tabs` replaces hand-rolled tablist |
| `app/layout.tsx` | minor | adds `AntdRegistry`; theme bootstrap script |
| `providers.tsx` | rewrite | new tree above |
| `Header.tsx` | rewrite | brand left; `ThemeToggle` + settings button + `WalletButton` right |
| `TransferCard.tsx` | rewrite | antd `Card` + `Form` + `Form.Item` + `InputNumber`; submit `Button type="primary" size="large" block loading={...}` |
| `AmountInput.tsx` | collapse | merged into `Form.Item` + `InputNumber` with `addonAfter={<SymbolPill/>}`; max-balance shortcut becomes adjacent `Button size="small"` |
| `ReceiveField.tsx` | collapse | merged into a read-only `Form.Item` + `Statistic` for the formatted output |
| `SymbolPill.tsx` | keep | reused as `addonAfter` |
| `ProtocolStats.tsx` | rewrite | `Statistic` cards in `Row`/`Col`; wrapped in `Suspense` with `Skeleton` fallback |
| `PendingTxList.tsx` | rewrite | antd `List` + `List.Item.Meta`; each item shows `BridgeSteps` (size="small"); `Empty` for the no-txs state |
| `SettingsDrawer.tsx` | rewrite | antd `Drawer` + `Form`; loaded via `next/dynamic` |
| `ToastHost.tsx` | delete | replaced by `App.useApp().notification` |
| `ErrorBoundary.tsx` | keep | fallback uses `Result status="error"` + retry `Button` |

New components:
- `BridgeSteps.tsx` — wraps antd `Steps` with the flow-status →
  step-index mapping. Single source of truth for "where is this
  bridge".
- `WalletButton.tsx` — primary `Button` when disconnected,
  `Dropdown` (address + disconnect) when connected.
- `ThemeToggle.tsx` — `Segmented` (☀️ / 🌙 / Auto), bound to
  `settings`.

### React perf rules baked in

- `rendering-conditional-render`: ternaries instead of `&&` in JSX.
- `rerender-no-inline-components`: subcomponents always defined at
  module scope.
- `rerender-defer-reads`: Zustand selectors so components subscribe
  only to slices they read.
- `rerender-derived-state-no-effect`: receive-amount derived during
  render from form input + quote query, never `useEffect`-stored.
- `rerender-lazy-state-init`: function form of `useState` for any
  expensive initial computation.
- `async-cheap-condition-before-await`: pre-checks (publicKey,
  amount, withdraw-singleton) run before the first `fetchQuery`.

### Form architecture

`TransferCard` uses antd `Form` with controlled validation:
- `Form.useForm()` for imperative submit/reset.
- `Form.useWatch('amount')` to drive the live receive-amount.
- `rules` for amount validation (positive, ≤ balance, decimals).
- `Form.onFinish` only fires when validation passes.

Collapses ~6 `useState`s into one form instance and gets submit-on-Enter
+ disabled-while-invalid for free.

## Data Flow

### Query keys

| Key | `staleTime` | `refetchInterval` | Notes |
|---|---|---|---|
| `['balances', publicKey, mint]` | `10s` | `15s` when tab visible, off when hidden | one query per (wallet, mint); visibility via `useDocumentVisible` in the `refetchInterval` callback |
| `['onyc-price']` | `60s` | `5min` | shared (`client-swr-dedup`) |
| `['protocol-state', programId]` | `30s` | `1min` | feeds `ProtocolStats` |
| `['bridge-fee', srcChain, dstChain, mint, amount]` | `30s` | none | refetched on input change via key |
| `['flow-status', flowId]` | `5s` while pending; `Infinity` once terminal | `5s` while pending | per-pending-tx |
| `['pending-txs']` | derived | n/a | a `useQueries` over flow IDs known from the persisted cache |

### Persistence

- `localStoragePersister` keyed `fogo-onre.queries.v1`.
- `dehydrateOptions.shouldDehydrateQuery`: only `['flow-status', ...]`
  queries persist. Balances/prices stay in-memory and refetch on load.
- `maxAge: 24h`. Older pending entries surface a warning state.
- Schema versioning per `client-localstorage-schema`: bump `.v1` to
  invalidate.

### Submit flow (deposit/withdraw)

1. `Form.onFinish` fires with `{ amount, recipient? }`.
2. Cheap pre-checks (`async-cheap-condition-before-await`):
   - `publicKey == null` → notification, return.
   - amount invalid → defensive return (validation already caught).
   - withdraw + non-terminal withdraw flow exists → notification
     "withdraw already in flight", return.
3. `queryClient.fetchQuery(['bridge-fee', ...])` — one-shot
   (`async-defer-await`).
4. Build NTT instruction via the SDK
   (`buildFogoNttDepositIx` / `buildFogoNttWithdrawIx`) — semantically
   unchanged.
5. Send via wallet adapter; on signature returned, immediately
   `queryClient.setQueryData(['flow-status', flowId], { status: 'pending', startedAt: Date.now() })`.
6. The cache entry triggers `PendingTxList` (a `useQueries` over
   known flow IDs) to render a new row; polling kicks in.
7. `notification.success` confirms submission.
8. On terminal status, `notification.success` again with a "view
   explorer" action; `staleTime` becomes `Infinity` so polling stops.

### Withdraw singleton guard

Relayer enforces a singleton `RedemptionTracker`. UI guard: withdraw
submit is disabled when any non-terminal withdraw `flow-status`
query exists. On-chain mutex remains the real enforcement.

## Error Handling

### Error boundaries

- Existing `ErrorBoundary` retained, fallback restyled to
  `Result status="error"` + reload `Button`.
- Boundaries on: `protocol stats`, the active tab's `TransferCard`,
  `recent transactions`, and the new `WalletButton`.

### Async error sink

- `notification.error({ key, message, description, btn })` from
  `App.useApp()` is the *only* user-visible async-error sink.
- Stable `key`s so retries replace prior notifications.
- `formatError(err)` maps known error classes (wallet-adapter
  `WalletSignTransactionError`, RPC errors with codes, NTT-specific
  errors) to friendly messages; unknown falls back to `err.message`.

### Query error policy

- `retry: 2` with exponential backoff for read queries.
- `retry: false` for the one-shot `fetchQuery` inside submit.
- `throwOnError: false` everywhere — render-time errors and runtime
  errors stay on separate channels.

### Loading states

- `Skeleton` inside `Suspense` for `ProtocolStats`.
- `Spin` for `TransferCard` while wallet is connecting.
- `Button loading` for in-flight submits.
- `List` `loading` while persisted queries rehydrate.

### SSR / hydration

- `<AntdRegistry>` in `app/layout.tsx` collects antd CSS during SSR.
- The app remains client-rendered (`'use client'` on `page.tsx`).
- Theme bootstrap script in `<head>` sets `data-theme` on `<html>`
  before hydration to prevent FOUC.

## Implementation Order

Each step keeps the app buildable.

1. **Provider scaffolding.** Add deps; rewrite `providers.tsx` and
   `app/layout.tsx`. Theme toggle wired. Old body still renders.
2. **Tailwind removal.** Strip configs/directives; convert `page.tsx`
   and `Header.tsx` layouts to antd `Layout`/`Flex`.
3. **Hooks → TanStack Query.** Rewrite `useBalances`,
   `useOnycPrice`, `useProtocolState`, `useBridgeFee`,
   `useFlowStatus`. RPC internals untouched. Old hook signatures
   preserved during this step.
4. **Pending-tx persistence.** Wrap with
   `PersistQueryClientProvider`; delete `store/pending-txs.ts`;
   `PendingTxList` becomes `useQueries` over persisted IDs.
5. **`TransferCard` rewrite.** antd `Form`; drop `AmountInput` /
   `ReceiveField`; submit handler implements the data-flow steps.
6. **Notifications.** Delete `ToastHost`/`store/toasts.ts`; replace
   every `pushToast` call site with `App.useApp().notification.X`.
7. **Polish.** `BridgeSteps` in `PendingTxList` items; `ProtocolStats`
   → `Statistic` + `Suspense`/`Skeleton`; `SettingsDrawer` → antd
   `Drawer` + `Form`; `ThemeToggle` in header.
8. **Bundle pass.** `next/dynamic` `SettingsDrawer` (and others if
   measurement helps); `next build`; review first-load JS.
9. **Cleanup.** Remove dead exports/CSS; `pnpm lint:fix`;
   `pnpm sdk build`.

## Validation (V1)

Manual devnet smoke checklist:

- [ ] App boots; theme toggle persists across reload; no FOUC.
- [ ] Wallet connect/disconnect; address visible in header dropdown.
- [ ] `ProtocolStats` renders real numbers.
- [ ] Deposit happy path: validation → submit → notification → row
      appears → `BridgeSteps` advances → terminal notification.
- [ ] Withdraw happy path: same.
- [ ] Withdraw concurrency block: second withdraw rejected with
      "already in flight"; no on-chain call made.
- [ ] Reload mid-flow: persisted `flow-status` keeps row visible and
      resumes polling.
- [ ] Wallet rejection during signing: `warning` notification; no
      flow row created.
- [ ] Error boundary: throwing inside `ProtocolStats` renders
      `Result`; `TransferCard` keeps working.
- [ ] `next build` succeeds; no console errors on dev server.

## Estimated Diff

- ~17 files modified
- 3 files deleted (`ToastHost.tsx`, `store/toasts.ts`,
  `store/pending-txs.ts`) plus Tailwind config files
- 3 files added (`BridgeSteps.tsx`, `WalletButton.tsx`,
  `ThemeToggle.tsx`)

## Risks

- **Wallet adapter integration with antd `Button` styling.** The
  adapter's default button has its own CSS. Mitigation: wrap, don't
  replace — `WalletButton` calls into the adapter hooks
  (`useWallet`, `useWalletModal`) and renders antd primitives.
- **CSS-in-JS SSR with App Router.** antd 5's `@ant-design/nextjs-registry`
  is the supported path; verify on first boot that styles aren't
  duplicated between SSR injection and client hydration.
- **TanStack Query persistence schema drift.** A future shape change
  to `flow-status` data without bumping the `v1` key would deserialize
  stale entries. Mitigation: a `version` field in the persisted
  payload + a migration step on rehydration.
- **Withdraw singleton UI guard race.** If a withdraw flow goes
  terminal between query refetch and submit, the guard might briefly
  block a legitimate second withdraw. Mitigation: re-check in
  `onFinish` against the live cache before notification.
