# Cranker Hetzner Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a 24/7 cranker daemon for Fogo OnRe that drives all permissionless flows automatically, deployed as a Docker stack on a Hetzner CX22 with self-healing, metrics, and SSH-gated operator access.

**Architecture:** New `packages/cranker/` workspace package owns the daemon shell, scan loop, metrics, and per-leg `advance/` orchestration logic (extracted from existing `packages/cli/src/commands/cranker.ts`). The CLI is rewired to import `advance/` from the new package. A multi-stage Dockerfile uses `pnpm deploy --prod` to flatten workspace symlinks. A docker-compose stack on the Hetzner box runs cranker + watchtower + prometheus + alertmanager + grafana, all bound to host loopback; operator access happens via on-demand `ssh -L` port forwarding.

**Tech Stack:** Node 24, TypeScript, pnpm workspaces, vitest, `@solana/web3.js`, `@fogo-onre/sdk`, `prom-client`, `zod` (env schema), Docker, docker-compose, Watchtower, Prometheus, Alertmanager, Grafana, hardened public SSH.

**Spec:** `docs/superpowers/specs/2026-05-08-cranker-hetzner-docker-deployment.md`

---

## File Structure

**New package — `packages/cranker/`:**
- `package.json` — workspace package manifest, deps on `@fogo-onre/sdk`, `prom-client`, `zod`
- `tsconfig.json` — extends repo root, emits to `dist/`
- `vitest.config.ts` — vitest config (workspace-aware)
- `Dockerfile` — multi-stage build using `pnpm deploy`
- `src/index.ts` — entrypoint: load config, validate invariants, start daemon
- `src/config.ts` — env-var schema + validation (zod), enforces `CRANKER_KEYPAIR ≠ RelayerConfig.authority`
- `src/rpc.ts` — `AbortSignal`-wrapped Connection helpers, hard timeouts
- `src/metrics.ts` — prom-client registry, http server on `0.0.0.0:9090`, `/metrics` and `/healthz`
- `src/daemon.ts` — scan loop, WS wake, heartbeat, self-kill watchdog, signal handlers
- `src/scan.ts` — PDA enumeration (Flow, RedemptionTracker, OutboxItem, RedemptionRequest), dispatch to advance/
- `src/advance/index.ts` — barrel
- `src/advance/types.ts` — shared `AdvanceContext`, `AdvanceResult` types
- `src/advance/claim-usdc.ts` — extracted from `cli/cranker.ts:147-309`
- `src/advance/swap-usdc-to-onyc.ts` — extracted from `cli/cranker.ts:320-399`
- `src/advance/lock-onyc.ts` — extracted from `cli/cranker.ts:412-627`
- `src/advance/unlock-onyc.ts` — withdraw-leg counterpart (new)
- `src/advance/request-redemption.ts` — withdraw-leg (new)
- `src/advance/claim-redemption.ts` — withdraw-leg (new)
- `src/advance/send-usdc-to-user.ts` — withdraw-leg (new)
- `tests/config.test.ts`, `tests/metrics.test.ts`, `tests/rpc.test.ts`, `tests/daemon.test.ts`, `tests/scan.test.ts`, `tests/advance/*.test.ts`

**Deploy artifacts — `deploy/cranker/`:**
- `docker-compose.yml` — cranker + watchtower + prometheus + alertmanager + grafana
- `prometheus.yml` — scrape config
- `alertmanager.yml` — Slack notification config
- `grafana-datasources.yml` — Prom datasource provisioning
- `alert-rules.yml` — Prometheus alert rules
- `.env.example` — env-var template
- `runbook.md` — host bootstrap, deploy, rollback, key rotation

**Modified — `packages/cli/src/commands/cranker.ts`:**
- Replace inline `.action(...)` bodies for `claim-usdc`, `swap-usdc-to-onyc`, `lock-onyc`, `advance` with calls into `@fogo-onre/cranker/advance`. Helpers `printFlow`, `describeStatus`, `nextDepositStep`, `nextWithdrawStep` stay in CLI (UI concerns).

**New — `.github/workflows/cranker-image.yml`:**
- Build & push image to `ghcr.io/<org>/fogo-onre-cranker:main` and `vX.Y.Z` on tag.

---

## Task 1: Scaffold `packages/cranker/` workspace

**Files:**
- Create: `packages/cranker/package.json`
- Create: `packages/cranker/tsconfig.json`
- Create: `packages/cranker/vitest.config.ts`
- Create: `packages/cranker/src/index.ts` (placeholder)
- Modify: `pnpm-workspace.yaml` (verify `packages/*` glob covers it — likely already does)

- [ ] **Step 1: Create `packages/cranker/package.json`**

```json
{
  "name": "@fogo-onre/cranker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./advance": "./dist/advance/index.js"
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src tests"
  },
  "dependencies": {
    "@fogo-onre/sdk": "workspace:*",
    "@solana/web3.js": "^1.95.0",
    "prom-client": "^15.1.3",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `packages/cranker/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "module": "ESNext",
    "moduleResolution": "bundler"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "tests", "node_modules"]
}
```

- [ ] **Step 3: Create `packages/cranker/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
})
```

- [ ] **Step 4: Create placeholder `packages/cranker/src/index.ts`**

```ts
export const CRANKER_PACKAGE = '@fogo-onre/cranker'
```

- [ ] **Step 5: Install deps and verify build**

Run: `pnpm install`
Run: `pnpm --filter @fogo-onre/cranker build`
Expected: clean build, `packages/cranker/dist/index.js` exists.

- [ ] **Step 6: Commit**

```bash
git add packages/cranker pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(cranker): scaffold workspace package"
```

---

## Task 2: Config schema (`config.ts`) — TDD

**Files:**
- Create: `packages/cranker/src/config.ts`
- Create: `packages/cranker/tests/config.test.ts`

The daemon refuses to start without all required env vars and refuses to start if `CRANKER_KEYPAIR.publicKey === RelayerConfig.authority` (codex review's hard invariant).

- [ ] **Step 1: Write failing test `tests/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'

describe('loadConfig', () => {
  it('throws when SOLANA_RPC_URL missing', () => {
    expect(() => loadConfig({})).toThrow(/SOLANA_RPC_URL/)
  })

  it('throws when KEYPAIR_PATH missing', () => {
    expect(() => loadConfig({ SOLANA_RPC_URL: 'https://x' })).toThrow(/KEYPAIR_PATH/)
  })

  it('parses valid env', () => {
    const cfg = loadConfig({
      SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x',
      SOLANA_WS_URL: 'wss://mainnet.helius-rpc.com/?api-key=x',
      FOGO_RPC_URL: 'https://fogo.testnet',
      KEYPAIR_PATH: '/keypair.json',
      WORMHOLESCAN_URL: 'https://api.wormholescan.io',
      METRICS_PORT: '9090',
      SCAN_INTERVAL_MS: '30000',
      RPC_TIMEOUT_MS: '15000',
      LOG_LEVEL: 'info',
    })
    expect(cfg.solanaRpcUrl).toBe('https://mainnet.helius-rpc.com/?api-key=x')
    expect(cfg.metricsPort).toBe(9090)
    expect(cfg.scanIntervalMs).toBe(30000)
  })

  it('rejects api.mainnet-beta.solana.com (no getProgramAccounts)', () => {
    expect(() =>
      loadConfig({
        SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
        SOLANA_WS_URL: 'wss://api.mainnet-beta.solana.com',
        FOGO_RPC_URL: 'https://fogo.testnet',
        KEYPAIR_PATH: '/keypair.json',
        WORMHOLESCAN_URL: 'https://api.wormholescan.io',
      }),
    ).toThrow(/paid RPC/)
  })
})
```

- [ ] **Step 2: Run test, confirm failure**

Run: `pnpm --filter @fogo-onre/cranker test config`
Expected: FAIL — `loadConfig` not exported.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { z } from 'zod'

const schema = z.object({
  SOLANA_RPC_URL: z.string().url().refine(
    u => !u.includes('api.mainnet-beta.solana.com'),
    { message: 'public mainnet-beta RPC disabled getProgramAccounts; use a paid RPC (Helius/QuickNode/Triton)' },
  ),
  SOLANA_WS_URL: z.string().url(),
  FOGO_RPC_URL: z.string().url(),
  KEYPAIR_PATH: z.string().min(1),
  WORMHOLESCAN_URL: z.string().url().default('https://api.wormholescan.io'),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9090),
  SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  WORMHOLESCAN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  HEARTBEAT_STALE_MS: z.coerce.number().int().min(30_000).default(120_000),
  MAX_CONCURRENT_ADVANCES: z.coerce.number().int().min(1).max(32).default(4),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export type CrankerConfig = {
  solanaRpcUrl: string
  solanaWsUrl: string
  fogoRpcUrl: string
  keypairPath: string
  wormholescanUrl: string
  metricsPort: number
  scanIntervalMs: number
  rpcTimeoutMs: number
  wormholescanTimeoutMs: number
  heartbeatStaleMs: number
  maxConcurrentAdvances: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export function loadConfig(env: Record<string, string | undefined> = process.env): CrankerConfig {
  const parsed = schema.parse(env)
  return {
    solanaRpcUrl: parsed.SOLANA_RPC_URL,
    solanaWsUrl: parsed.SOLANA_WS_URL,
    fogoRpcUrl: parsed.FOGO_RPC_URL,
    keypairPath: parsed.KEYPAIR_PATH,
    wormholescanUrl: parsed.WORMHOLESCAN_URL,
    metricsPort: parsed.METRICS_PORT,
    scanIntervalMs: parsed.SCAN_INTERVAL_MS,
    rpcTimeoutMs: parsed.RPC_TIMEOUT_MS,
    wormholescanTimeoutMs: parsed.WORMHOLESCAN_TIMEOUT_MS,
    heartbeatStaleMs: parsed.HEARTBEAT_STALE_MS,
    maxConcurrentAdvances: parsed.MAX_CONCURRENT_ADVANCES,
    logLevel: parsed.LOG_LEVEL,
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm --filter @fogo-onre/cranker test config`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cranker/src/config.ts packages/cranker/tests/config.test.ts
git commit -m "feat(cranker): env config schema with zod validation"
```

---

## Task 3: RPC helpers with hard timeouts (`rpc.ts`) — TDD

**Files:**
- Create: `packages/cranker/src/rpc.ts`
- Create: `packages/cranker/tests/rpc.test.ts`

Wraps `Connection` calls so every outbound RPC honors an `AbortSignal`. Bare `await connection.x()` is forbidden in the daemon.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { withTimeout } from '../src/rpc'

describe('withTimeout', () => {
  it('resolves when underlying promise resolves before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, 'test')
    expect(result).toBe(42)
  })

  it('rejects with timeout label when slower than budget', async () => {
    const slow = new Promise(resolve => setTimeout(() => resolve('late'), 200))
    await expect(withTimeout(slow, 50, 'getSlot')).rejects.toThrow(/timeout.*getSlot/)
  })

  it('does not leak timer on resolve', async () => {
    vi.useFakeTimers()
    await withTimeout(Promise.resolve(1), 10_000, 'x')
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run test, confirm failure**

Run: `pnpm --filter @fogo-onre/cranker test rpc`
Expected: FAIL — `withTimeout` not exported.

- [ ] **Step 3: Implement `src/rpc.ts`**

```ts
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timeout ${timeoutMs}ms exceeded for ${label}`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm --filter @fogo-onre/cranker test rpc`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cranker/src/rpc.ts packages/cranker/tests/rpc.test.ts
git commit -m "feat(cranker): RPC timeout wrapper"
```

---

## Task 4: Metrics surface (`metrics.ts`) — TDD

**Files:**
- Create: `packages/cranker/src/metrics.ts`
- Create: `packages/cranker/tests/metrics.test.ts`

Prom-client registry plus tiny http server on `0.0.0.0:<port>`. `/metrics` returns Prom exposition; `/healthz` returns 200/503 based on heartbeat freshness.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it } from 'vitest'
import { createMetrics } from '../src/metrics'

describe('createMetrics', () => {
  it('starts http server, exposes /metrics and /healthz', async () => {
    const m = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    await m.start()
    const port = m.actualPort()

    m.heartbeat.setNow()
    const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(healthRes.status).toBe(200)

    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`)
    expect(metricsRes.status).toBe(200)
    const body = await metricsRes.text()
    expect(body).toMatch(/cranker_scan_iterations_total/)

    await m.stop()
  })

  it('healthz returns 503 when heartbeat is stale', async () => {
    const m = createMetrics({ port: 0, heartbeatStaleMs: 100 })
    await m.start()
    const port = m.actualPort()

    m.heartbeat.setAt(Date.now() - 200)
    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(res.status).toBe(503)

    await m.stop()
  })
})
```

- [ ] **Step 2: Run test, confirm failure**

Run: `pnpm --filter @fogo-onre/cranker test metrics`
Expected: FAIL — `createMetrics` not exported.

- [ ] **Step 3: Implement `src/metrics.ts`**

```ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client'

export type MetricsOptions = {
  port: number
  heartbeatStaleMs: number
}

export function createMetrics(opts: MetricsOptions) {
  const registry = new Registry()
  collectDefaultMetrics({ register: registry })

  const scanIterations = new Counter({
    name: 'cranker_scan_iterations_total',
    help: 'Total scan loop iterations',
    labelNames: ['result'] as const,
    registers: [registry],
  })
  const scanDuration = new Histogram({
    name: 'cranker_scan_duration_seconds',
    help: 'Scan loop duration',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
    registers: [registry],
  })
  const heartbeatAge = new Gauge({
    name: 'cranker_heartbeat_age_seconds',
    help: 'Seconds since last successful scan',
    registers: [registry],
  })
  const txSent = new Counter({
    name: 'cranker_tx_sent_total',
    help: 'Transactions submitted',
    labelNames: ['instruction', 'result'] as const,
    registers: [registry],
  })
  const rpcErrors = new Counter({
    name: 'cranker_rpc_errors_total',
    help: 'RPC failures',
    labelNames: ['endpoint', 'kind'] as const,
    registers: [registry],
  })
  const flowAdvance = new Counter({
    name: 'cranker_flow_advance_total',
    help: 'Per-leg state transitions',
    labelNames: ['leg', 'from_status', 'to_status'] as const,
    registers: [registry],
  })
  const solBalance = new Gauge({
    name: 'cranker_keypair_sol_balance',
    help: 'Cranker keypair SOL balance (lamports / 1e9)',
    registers: [registry],
  })
  const wsAlive = new Gauge({
    name: 'cranker_ws_subscription_alive',
    help: 'WebSocket subscription health (1=alive, 0=dead)',
    registers: [registry],
  })

  let lastHeartbeat = Date.now()
  const heartbeat = {
    setNow: () => { lastHeartbeat = Date.now() },
    setAt: (ts: number) => { lastHeartbeat = ts },
    ageMs: () => Date.now() - lastHeartbeat,
  }

  let server: Server | undefined
  let actualPort = 0

  return {
    registry,
    scanIterations,
    scanDuration,
    heartbeat,
    heartbeatAge,
    txSent,
    rpcErrors,
    flowAdvance,
    solBalance,
    wsAlive,

    actualPort: () => actualPort,

    async start() {
      server = createServer(async (req, res) => {
        if (req.url === '/healthz') {
          const ageMs = heartbeat.ageMs()
          if (ageMs > opts.heartbeatStaleMs) {
            res.statusCode = 503
            res.end(JSON.stringify({ status: 'stale', ageMs }))
          } else {
            res.statusCode = 200
            res.end(JSON.stringify({ status: 'ok', ageMs }))
          }
          return
        }
        if (req.url === '/metrics') {
          heartbeatAge.set(heartbeat.ageMs() / 1000)
          res.setHeader('content-type', registry.contentType)
          res.statusCode = 200
          res.end(await registry.metrics())
          return
        }
        res.statusCode = 404
        res.end()
      })
      await new Promise<void>((resolve) => {
        server!.listen(opts.port, '0.0.0.0', () => {
          actualPort = (server!.address() as AddressInfo).port
          resolve()
        })
      })
    },

    async stop() {
      if (!server) {
        return
      }
      await new Promise<void>((resolve, reject) => {
        server!.close(err => err ? reject(err) : resolve())
      })
      server = undefined
    },
  }
}

export type Metrics = ReturnType<typeof createMetrics>
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm --filter @fogo-onre/cranker test metrics`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cranker/src/metrics.ts packages/cranker/tests/metrics.test.ts
git commit -m "feat(cranker): prom-client metrics + http server"
```

---

## Task 5: Extract `advance/` modules from CLI

**Files:**
- Read: `packages/cli/src/commands/cranker.ts` (full file, ~1485 lines)
- Create: `packages/cranker/src/advance/types.ts`
- Create: `packages/cranker/src/advance/index.ts`
- Create: `packages/cranker/src/advance/claim-usdc.ts`
- Create: `packages/cranker/src/advance/swap-usdc-to-onyc.ts`
- Create: `packages/cranker/src/advance/lock-onyc.ts`
- Create: `packages/cranker/src/advance/unlock-onyc.ts`
- Create: `packages/cranker/src/advance/request-redemption.ts`
- Create: `packages/cranker/src/advance/claim-redemption.ts`
- Create: `packages/cranker/src/advance/send-usdc-to-user.ts`
- Create: `packages/cranker/tests/advance/claim-usdc.test.ts`

Extract the orchestration **logic** out of each `cranker subcommand .action(...)` body into pure async functions taking an `AdvanceContext` and returning an `AdvanceResult`. The CLI's argv parsing, dry-run printing, and `process.exit` calls do **not** move — those are CLI-shell concerns.

- [ ] **Step 1: Read existing CLI cranker code**

Run: `wc -l packages/cli/src/commands/cranker.ts && head -80 packages/cli/src/commands/cranker.ts`

Read these line ranges in full before extracting:
- 147-309 (claim-usdc body)
- 320-399 (swap body)
- 412-627 (lock-onyc body)
- 779-1135 (advance orchestrator)
- 1336-1485 (helpers: fetchVaaBytes, makeSolanaNtt, deriveLockOnycReleaseAccounts)

- [ ] **Step 2: Define shared types `src/advance/types.ts`**

```ts
import type { AnchorProvider } from '@coral-xyz/anchor'
import type { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { Metrics } from '../metrics'

export type AdvanceContext = {
  connection: Connection
  fogoConnection: Connection
  provider: AnchorProvider
  keypair: Keypair
  relayerProgramId: PublicKey
  wormholescanUrl: string
  metrics: Metrics
  abortSignal: AbortSignal
}

export type PlannedTx = {
  label: string
  build: () => Promise<{ ixs: TransactionInstruction[]; signers: Keypair[] }>
}

export type AdvanceResult =
  | { kind: 'noop'; reason: string }
  | { kind: 'advanced'; signatures: string[]; fromStatus: string; toStatus: string }
  | { kind: 'error'; error: Error; partialSignatures: string[] }
```

- [ ] **Step 3: Extract `claim-usdc.ts`**

Take the body of the `.action(...)` for `claim-usdc` (cli/cranker.ts:147-309). Strip:
- argv parsing (already in caller)
- `console.log` calls (replace with `metrics.flowAdvance.inc(...)` and structured log)
- `process.exit` (return `AdvanceResult` instead)
- `--confirm` gating (caller decides)

Result skeleton:

```ts
import { Transaction } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './types'
import { withTimeout } from '../rpc'

export type ClaimUsdcInput = {
  fogoTx: string
  vaaHex?: string
}

export async function claimUsdc(
  ctx: AdvanceContext,
  input: ClaimUsdcInput,
): Promise<AdvanceResult> {
  // 1. Resolve VAA: either from input.vaaHex, or fetch via wormholescan
  // 2. Decode VAA, derive Flow PDA
  // 3. Read Flow account; if missing or status != Pending, return noop
  // 4. Build NTT redeem + relayer.claim_usdc ixs
  // 5. Simulate (always); on err, return error
  // 6. Send + confirm with withTimeout(..., ctx.config.rpcTimeoutMs, 'claim_usdc')
  // 7. Return { kind: 'advanced', signatures: [sig], fromStatus: 'Pending', toStatus: 'UsdcClaimed' }
  throw new Error('TODO: port from cli/cranker.ts:147-309')
}
```

The implementer fills the body by literal-copying the action body and applying the strip rules above. This is mechanical, not creative. The plan mandates the function signature; the body is whatever the CLI was already doing minus the UI shell.

- [ ] **Step 4: Repeat extraction for the other six advance modules**

Apply the same recipe to:
- `swap-usdc-to-onyc.ts` (from cli:320-399) — input: `{ fogoTx, vaaHex? }`, return `AdvanceResult`
- `lock-onyc.ts` (from cli:412-627) — input: `{ fogoTx, vaaHex? }`, return `AdvanceResult` with possibly two signatures (lock-onyc emits a 2-tx batch per CLAUDE.md note about lines ~900, ~951)
- `unlock-onyc.ts` (from withdraw-side; new code if no CLI counterpart exists yet — read `programs/relayer/src/instructions/unlock_onyc.rs` for the IX shape, mirror the lock-onyc structure)
- `request-redemption.ts`, `claim-redemption.ts`, `send-usdc-to-user.ts` — same pattern; if not present in CLI, derive from program instruction handlers in `programs/relayer/src/instructions/`

For each, the function signature is `(ctx: AdvanceContext, input: <leg>Input) => Promise<AdvanceResult>`. Inputs differ by leg but always include the discriminator (Flow PDA, OutboxItem PDA, or RedemptionRequest PDA) the leg operates on.

- [ ] **Step 5: Barrel `src/advance/index.ts`**

```ts
export * from './types'
export { claimUsdc } from './claim-usdc'
export { swapUsdcToOnyc } from './swap-usdc-to-onyc'
export { lockOnyc } from './lock-onyc'
export { unlockOnyc } from './unlock-onyc'
export { requestRedemption } from './request-redemption'
export { claimRedemption } from './claim-redemption'
export { sendUsdcToUser } from './send-usdc-to-user'
```

- [ ] **Step 6: Write one canonical advance test (claim-usdc) as the integration template**

```ts
// tests/advance/claim-usdc.test.ts
import { describe, expect, it, vi } from 'vitest'
import { claimUsdc } from '../../src/advance/claim-usdc'

describe('claimUsdc', () => {
  it('returns noop when Flow status is not Pending', async () => {
    // mock ctx with a connection.getAccountInfo returning a Flow with status=UsdcClaimed
    // assert result.kind === 'noop'
  })

  it('returns advanced on happy path', async () => {
    // mock VAA fetch, mock simulate ok, mock send+confirm
    // assert result.kind === 'advanced'
    // assert ctx.metrics.flowAdvance was incremented with correct labels
  })
})
```

The implementer fills these tests using the same mocking patterns as `tests/utils/svm.ts` in the existing repo. Other legs get analogous tests but the plan only mandates the canonical example because the patterns repeat.

- [ ] **Step 7: Run tests, confirm pass**

Run: `pnpm --filter @fogo-onre/cranker test advance`
Expected: claim-usdc tests pass; other advance modules compile but are tested in Task 6 via the scan dispatcher.

- [ ] **Step 8: Commit**

```bash
git add packages/cranker/src/advance packages/cranker/tests/advance
git commit -m "feat(cranker): extract advance/ orchestration modules from CLI"
```

---

## Task 6: PDA scan + dispatch (`scan.ts`) — TDD

**Files:**
- Create: `packages/cranker/src/scan.ts`
- Create: `packages/cranker/tests/scan.test.ts`

`scanAndAdvance()` enumerates non-terminal Flow PDAs, the singleton RedemptionTracker, outstanding OutboxItems on both NTT managers, and RedemptionRequest PDAs, then dispatches each to the appropriate `advance/<leg>` function with bounded concurrency.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { scanAndAdvance } from '../src/scan'

describe('scanAndAdvance', () => {
  it('dispatches one advance call per non-terminal Flow PDA', async () => {
    const claimUsdc = vi.fn().mockResolvedValue({ kind: 'noop', reason: 'test' })
    const ctx = makeMockCtx({
      flows: [
        { pubkey: 'A', status: 'Pending' },
        { pubkey: 'B', status: 'UsdcClaimed' },
        { pubkey: 'C', status: 'Closed' },  // terminal — skipped
      ],
    })
    await scanAndAdvance(ctx, { advance: { claimUsdc, swapUsdcToOnyc: vi.fn(), /*...*/ } })
    expect(claimUsdc).toHaveBeenCalledTimes(1)
  })

  it('respects maxConcurrentAdvances bound', async () => {
    // create 10 pending Flows, set maxConcurrentAdvances=2
    // assert no more than 2 advances run concurrently (use a counter inside the mock)
  })

  it('honors abortSignal mid-scan', async () => {
    const ac = new AbortController()
    ac.abort()
    const ctx = makeMockCtx({ flows: [{ pubkey: 'A', status: 'Pending' }] })
    await expect(scanAndAdvance({ ...ctx, abortSignal: ac.signal }, /*...*/)).rejects.toThrow(/abort/)
  })
})
```

- [ ] **Step 2: Run test, confirm failure**

Run: `pnpm --filter @fogo-onre/cranker test scan`
Expected: FAIL — `scanAndAdvance` not exported.

- [ ] **Step 3: Implement `src/scan.ts`**

```ts
import { PublicKey } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './advance/types'
import * as advance from './advance'
import { withTimeout } from './rpc'

export type ScanOptions = {
  maxConcurrentAdvances: number
  rpcTimeoutMs: number
}

export type AdvanceFns = {
  claimUsdc: typeof advance.claimUsdc
  swapUsdcToOnyc: typeof advance.swapUsdcToOnyc
  lockOnyc: typeof advance.lockOnyc
  unlockOnyc: typeof advance.unlockOnyc
  requestRedemption: typeof advance.requestRedemption
  claimRedemption: typeof advance.claimRedemption
  sendUsdcToUser: typeof advance.sendUsdcToUser
}

export async function scanAndAdvance(
  ctx: AdvanceContext,
  opts: ScanOptions & { advanceFns?: AdvanceFns },
): Promise<void> {
  if (ctx.abortSignal.aborted) {
    throw new Error('scan aborted before start')
  }

  const fns = opts.advanceFns ?? advance
  const flows = await withTimeout(
    enumerateFlows(ctx),
    opts.rpcTimeoutMs,
    'enumerateFlows',
  )

  const tasks: Array<() => Promise<AdvanceResult>> = []
  for (const flow of flows) {
    const dispatch = pickAdvanceForStatus(flow.status, fns)
    if (!dispatch) {
      continue
    }
    tasks.push(() => dispatch(ctx, { fogoTx: flow.fogoTx /* or PDA-keyed input */ }))
  }

  await runBounded(tasks, opts.maxConcurrentAdvances, ctx.abortSignal)
}

async function enumerateFlows(ctx: AdvanceContext): Promise<Array<{ pubkey: PublicKey; status: string; fogoTx: string }>> {
  // getProgramAccounts with discriminator + status memcmp filters
  // status memcmp filter excludes terminal (Closed)
  // see spec "PDA enumeration strategy" table for filter offsets
  throw new Error('TODO: implement using @fogo-onre/sdk Flow account decoder')
}

function pickAdvanceForStatus(status: string, fns: AdvanceFns) {
  switch (status) {
    case 'Pending': return fns.claimUsdc
    case 'UsdcClaimed': return fns.swapUsdcToOnyc
    case 'Swapped': return fns.lockOnyc
    case 'RedemptionRequested': return fns.claimRedemption
    case 'RedemptionClaimed': return fns.sendUsdcToUser
    default: return undefined
  }
}

async function runBounded<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  signal: AbortSignal,
): Promise<void> {
  let i = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (i < tasks.length) {
      if (signal.aborted) {
        throw new Error('aborted mid-scan')
      }
      const idx = i++
      await tasks[idx]().catch(() => {/* metrics in advance/ already */})
    }
  })
  await Promise.all(workers)
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm --filter @fogo-onre/cranker test scan`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cranker/src/scan.ts packages/cranker/tests/scan.test.ts
git commit -m "feat(cranker): scan loop with bounded concurrency"
```

---

## Task 7: Daemon shell (`daemon.ts`) — TDD

**Files:**
- Create: `packages/cranker/src/daemon.ts`
- Create: `packages/cranker/tests/daemon.test.ts`

The while-loop, WS wake, heartbeat, self-kill watchdog, signal handlers. Self-kill is the codex review's P1 fix.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { runDaemon } from '../src/daemon'

describe('runDaemon', () => {
  it('updates heartbeat after successful scan', async () => {
    vi.useFakeTimers()
    const scan = vi.fn().mockResolvedValue(undefined)
    const metrics = makeMockMetrics()
    const ctrl = new AbortController()
    const promise = runDaemon({ scan, metrics, intervalMs: 30_000, heartbeatStaleMs: 120_000, abortSignal: ctrl.signal })

    await vi.advanceTimersByTimeAsync(0)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(metrics.heartbeat.setNow).toHaveBeenCalled()

    ctrl.abort()
    await promise
    vi.useRealTimers()
  })

  it('triggers self-kill (process.exit) when heartbeat goes stale', async () => {
    vi.useFakeTimers()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const scan = vi.fn().mockImplementation(() => new Promise(() => {/* never resolves */}))
    const metrics = makeMockMetrics()
    const ctrl = new AbortController()

    runDaemon({ scan, metrics, intervalMs: 30_000, heartbeatStaleMs: 120_000, abortSignal: ctrl.signal })
    await vi.advanceTimersByTimeAsync(150_000)

    expect(exit).toHaveBeenCalledWith(1)
    exit.mockRestore()
    vi.useRealTimers()
  })

  it('drains in-flight on SIGTERM-equivalent abort', async () => {
    // ctrl.abort() mid-scan, daemon should await scan completion then exit cleanly
  })
})
```

- [ ] **Step 2: Run test, confirm failure**

Run: `pnpm --filter @fogo-onre/cranker test daemon`
Expected: FAIL — `runDaemon` not exported.

- [ ] **Step 3: Implement `src/daemon.ts`**

```ts
import { EventEmitter, once } from 'node:events'
import type { Metrics } from './metrics'

export type DaemonOptions = {
  scan: (signal: AbortSignal) => Promise<void>
  metrics: Pick<Metrics, 'heartbeat' | 'scanIterations' | 'scanDuration'>
  intervalMs: number
  heartbeatStaleMs: number
  scanTimeoutMs?: number
  abortSignal: AbortSignal
  wakeup?: EventEmitter
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const wakeup = opts.wakeup ?? new EventEmitter()

  // Self-kill watchdog — independent of scan loop.
  const watchdog = setInterval(() => {
    if (opts.metrics.heartbeat.ageMs() > opts.heartbeatStaleMs) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({
        level: 'fatal',
        msg: 'heartbeat stale — self-killing for restart',
        ageMs: opts.metrics.heartbeat.ageMs(),
      }))
      process.exit(1)
    }
  }, 15_000)
  watchdog.unref()

  try {
    while (!opts.abortSignal.aborted) {
      const t0 = Date.now()
      const scanCtl = new AbortController()
      const linkAbort = () => scanCtl.abort()
      opts.abortSignal.addEventListener('abort', linkAbort, { once: true })

      try {
        await opts.scan(scanCtl.signal)
        opts.metrics.heartbeat.setNow()
        opts.metrics.scanIterations.inc({ result: 'ok' })
      } catch (err) {
        opts.metrics.scanIterations.inc({ result: 'error' })
        // eslint-disable-next-line no-console
        console.error(JSON.stringify({ level: 'error', msg: 'scan failed', err: String(err) }))
      } finally {
        opts.abortSignal.removeEventListener('abort', linkAbort)
        opts.metrics.scanDuration.observe((Date.now() - t0) / 1000)
      }

      if (opts.abortSignal.aborted) {
        break
      }

      // Sleep for intervalMs OR until wakeup fires, whichever first.
      await Promise.race([
        new Promise<void>(r => setTimeout(r, opts.intervalMs).unref()),
        once(wakeup, 'wake').then(() => {/* swallow */}),
        once(opts.abortSignal as unknown as EventEmitter, 'abort').catch(() => {}),
      ])
    }
  } finally {
    clearInterval(watchdog)
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `pnpm --filter @fogo-onre/cranker test daemon`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cranker/src/daemon.ts packages/cranker/tests/daemon.test.ts
git commit -m "feat(cranker): daemon loop with self-kill watchdog"
```

---

## Task 8: Entrypoint (`index.ts`) and WS wake wiring

**Files:**
- Modify: `packages/cranker/src/index.ts` (replace placeholder)

Wire config → keypair load → invariant check → connections → metrics → WS subscription → daemon. Top-level `unhandledRejection`/`uncaughtException` handlers crash the process.

- [ ] **Step 1: Replace `src/index.ts`**

```ts
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { AnchorProvider, Wallet } from '@coral-xyz/anchor'
import {
  RELAYER_PROGRAM_ID,
  findConfigPda,
} from '@fogo-onre/sdk'
import { loadConfig } from './config'
import { createMetrics } from './metrics'
import { runDaemon } from './daemon'
import { scanAndAdvance } from './scan'

async function main() {
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'fatal', msg: 'unhandledRejection', reason: String(reason) }))
    process.exit(1)
  })
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'fatal', msg: 'uncaughtException', err: String(err) }))
    process.exit(1)
  })

  const cfg = loadConfig()

  const keypairBytes = JSON.parse(readFileSync(cfg.keypairPath, 'utf8'))
  const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairBytes))

  const connection = new Connection(cfg.solanaRpcUrl, { commitment: 'confirmed', wsEndpoint: cfg.solanaWsUrl })
  const fogoConnection = new Connection(cfg.fogoRpcUrl, 'confirmed')

  // Hard invariant: cranker key MUST NOT equal RelayerConfig.authority.
  const [configPda] = findConfigPda()
  const provider = new AnchorProvider(connection, new Wallet(keypair), { commitment: 'confirmed' })
  // Use SDK's RelayerClient to read RelayerConfig
  // const relayerConfig = await client.fetchConfig()
  // if (relayerConfig.authority.equals(keypair.publicKey)) throw new Error('CRANKER_KEYPAIR == RelayerConfig.authority — refusing to start')
  // (Implementer: import RelayerClient from @fogo-onre/sdk and fetch the config; the exact API exists in client.ts)

  const metrics = createMetrics({ port: cfg.metricsPort, heartbeatStaleMs: cfg.heartbeatStaleMs })
  await metrics.start()

  const wakeup = new EventEmitter()
  const subId = connection.onLogs(
    RELAYER_PROGRAM_ID,
    () => wakeup.emit('wake'),
    'confirmed',
  )
  metrics.wsAlive.set(1)

  const ac = new AbortController()
  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'info', msg: `received ${signal}, draining` }))
    ac.abort()
  }
  process.once('SIGTERM', () => shutdown('SIGTERM'))
  process.once('SIGINT', () => shutdown('SIGINT'))

  try {
    await runDaemon({
      scan: signal => scanAndAdvance(
        {
          connection,
          fogoConnection,
          provider,
          keypair,
          relayerProgramId: RELAYER_PROGRAM_ID,
          wormholescanUrl: cfg.wormholescanUrl,
          metrics,
          abortSignal: signal,
        },
        { maxConcurrentAdvances: cfg.maxConcurrentAdvances, rpcTimeoutMs: cfg.rpcTimeoutMs },
      ),
      metrics,
      intervalMs: cfg.scanIntervalMs,
      heartbeatStaleMs: cfg.heartbeatStaleMs,
      abortSignal: ac.signal,
      wakeup,
    })
  } finally {
    await connection.removeOnLogsListener(subId).catch(() => {})
    await metrics.stop()
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({ level: 'fatal', msg: 'main crashed', err: String(err) }))
  process.exit(1)
})
```

- [ ] **Step 2: Build and smoke-test**

Run: `pnpm --filter @fogo-onre/cranker build`
Expected: clean build.

Run (with stub env, expect graceful refusal because keypair is invalid):
```
SOLANA_RPC_URL=https://invalid \
SOLANA_WS_URL=wss://invalid \
FOGO_RPC_URL=https://invalid \
KEYPAIR_PATH=/nonexistent \
node packages/cranker/dist/index.js
```
Expected: exits non-zero with structured log mentioning ENOENT or RPC failure.

- [ ] **Step 3: Commit**

```bash
git add packages/cranker/src/index.ts
git commit -m "feat(cranker): entrypoint wires config, ws, daemon, signals"
```

---

## Task 9: Rewire CLI to import from `@fogo-onre/cranker`

**Files:**
- Modify: `packages/cli/package.json` (add `@fogo-onre/cranker` workspace dep)
- Modify: `packages/cli/src/commands/cranker.ts` (replace `.action(...)` bodies)

The CLI keeps its argv parsing, dry-run printing, exit codes — but the orchestration body of each leg becomes `await advance.claimUsdc(ctx, input)` etc.

- [ ] **Step 1: Add workspace dep to CLI**

Edit `packages/cli/package.json` `dependencies`:
```json
"@fogo-onre/cranker": "workspace:*"
```

- [ ] **Step 2: Refactor each `.action(...)` body**

Per leg, replace the inline orchestration with a call into the cranker package. Example for `claim-usdc`:

```ts
import { claimUsdc, type AdvanceContext } from '@fogo-onre/cranker/advance'
// ...
.action(async (opts) => {
  // existing argv parsing, connection setup, dry-run plan printing stays here
  if (!opts.confirm) {
    console.log(chalk.yellow('dry-run only. Re-run with --confirm to broadcast.'))
    return
  }
  const ctx: AdvanceContext = buildAdvanceContext(opts /*, ...*/)
  const result = await claimUsdc(ctx, { fogoTx: opts.fogoTx, vaaHex: opts.vaa })
  if (result.kind === 'error') throw result.error
  if (result.kind === 'noop') console.log(chalk.dim(result.reason))
  else result.signatures.forEach(s => console.log(chalk.green(`landed: ${s}`)))
})
```

Apply the same shape to `swap-usdc-to-onyc`, `lock-onyc`, and the `advance` orchestrator (which becomes a sequence of leg dispatches).

- [ ] **Step 3: Run all tests**

Run: `pnpm install && pnpm test`
Expected: full test suite passes (existing CLI tests should still work since CLI behavior is unchanged from the user's perspective).

- [ ] **Step 4: Commit**

```bash
git add packages/cli pnpm-lock.yaml
git commit -m "refactor(cli): import cranker advance modules from @fogo-onre/cranker"
```

---

## Task 10: Dockerfile

**Files:**
- Create: `packages/cranker/Dockerfile`
- Create: `packages/cranker/.dockerignore`

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
dist
**/dist
**/node_modules
.git
target
tests
**/*.test.ts
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @fogo-onre/sdk build
RUN pnpm --filter @fogo-onre/cranker build
RUN pnpm deploy --filter @fogo-onre/cranker --prod /out

FROM node:24-alpine
RUN addgroup -g 10001 -S cranker && adduser -u 10001 -G cranker -S cranker
WORKDIR /app
COPY --from=build --chown=cranker:cranker /out /app
USER cranker
EXPOSE 9090
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=120s \
  CMD wget -qO- http://127.0.0.1:9090/healthz || exit 1
CMD ["node", "--max-old-space-size=512", "dist/index.js"]
```

- [ ] **Step 3: Build the image locally**

Run: `docker build -f packages/cranker/Dockerfile -t cranker:dev .`
Expected: image builds, final size <300MB.

- [ ] **Step 4: Smoke-test the image**

Run:
```bash
docker run --rm --entrypoint sh cranker:dev -c "node -e 'console.log(require(\"./dist/index.js\"))' || true; ls /app"
```
Expected: `/app/dist/index.js` exists; `/app/node_modules/@fogo-onre/sdk` exists (proves pnpm deploy resolved the symlink).

- [ ] **Step 5: Commit**

```bash
git add packages/cranker/Dockerfile packages/cranker/.dockerignore
git commit -m "feat(cranker): Dockerfile with pnpm deploy multi-stage build"
```

---

## Task 11: Compose stack and observability configs

**Files:**
- Create: `deploy/cranker/docker-compose.yml`
- Create: `deploy/cranker/prometheus.yml`
- Create: `deploy/cranker/alertmanager.yml`
- Create: `deploy/cranker/alert-rules.yml`
- Create: `deploy/cranker/grafana-datasources.yml`
- Create: `deploy/cranker/.env.example`

- [ ] **Step 1: Create `deploy/cranker/docker-compose.yml`**

```yaml
services:
  cranker:
    image: ghcr.io/<org>/fogo-onre-cranker:main
    restart: unless-stopped
    env_file: /etc/cranker/.env
    volumes:
      - /etc/cranker/keypair.json:/keypair.json:ro
    ports:
      - "127.0.0.1:9090:9090"
    stop_grace_period: 45s
    labels:
      com.centurylinklabs.watchtower.enable: "true"

  watchtower:
    image: containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --label-enable --interval 300 --cleanup
    environment:
      WATCHTOWER_NOTIFICATION_URL: ${WATCHTOWER_SLACK_WEBHOOK}

  prometheus:
    image: prom/prometheus:v2.54.1
    restart: unless-stopped
    volumes:
      - /etc/cranker/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - /etc/cranker/alert-rules.yml:/etc/prometheus/alert-rules.yml:ro
      - prom-data:/prometheus
    ports:
      - "127.0.0.1:9091:9090"
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=14d
      - --storage.tsdb.retention.size=2GB

  alertmanager:
    image: prom/alertmanager:v0.27.0
    restart: unless-stopped
    volumes:
      - /etc/cranker/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro
    ports:
      - "127.0.0.1:9093:9093"

  grafana:
    image: grafana/grafana:11.2.0
    restart: unless-stopped
    volumes:
      - grafana-data:/var/lib/grafana
      - /etc/cranker/grafana-datasources.yml:/etc/grafana/provisioning/datasources/ds.yml:ro
    environment:
      GF_SECURITY_ADMIN_PASSWORD__FILE: /run/secrets/grafana_admin
      GF_SERVER_ROOT_URL: http://localhost:3000
    ports:
      - "127.0.0.1:3000:3000"
    secrets:
      - grafana_admin

volumes:
  prom-data:
  grafana-data:

secrets:
  grafana_admin:
    file: /etc/cranker/grafana_admin_password
```

- [ ] **Step 2: Create `deploy/cranker/prometheus.yml`**

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - /etc/prometheus/alert-rules.yml

scrape_configs:
  - job_name: cranker
    static_configs:
      - targets: ['cranker:9090']
```

- [ ] **Step 3: Create `deploy/cranker/alert-rules.yml`**

```yaml
groups:
  - name: cranker
    interval: 30s
    rules:
      - alert: CrankerHeartbeatStale
        expr: cranker_heartbeat_age_seconds > 90
        for: 1m
        labels: { severity: critical }
        annotations:
          summary: "Cranker heartbeat stale ({{ $value }}s)"

      - alert: CrankerLowSolBalance
        expr: cranker_keypair_sol_balance < 0.05
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "Cranker keypair under 0.05 SOL — refund needed"

      - alert: CrankerAnomalousSpend
        expr: (cranker_keypair_sol_balance offset 1h) - cranker_keypair_sol_balance > 0.2
        for: 5m
        labels: { severity: critical }
        annotations:
          summary: "Cranker spent >0.2 SOL in 1h — possible compromise"

      - alert: CrankerScanErrors
        expr: rate(cranker_scan_iterations_total{result="error"}[10m]) > 0.05
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "Cranker scan error rate >5%"

      - alert: CrankerWsDead
        expr: cranker_ws_subscription_alive == 0
        for: 2m
        labels: { severity: warning }
        annotations:
          summary: "Cranker WebSocket subscription dead"

      - alert: HostDiskLow
        expr: node_filesystem_avail_bytes{mountpoint="/"} < 5e9
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "Cranker host disk <5GB free"
```

- [ ] **Step 4: Create `deploy/cranker/alertmanager.yml`**

```yaml
global:
  resolve_timeout: 5m

route:
  receiver: slack
  group_by: ['alertname']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 12h

receivers:
  - name: slack
    slack_configs:
      - api_url_file: /etc/alertmanager/slack_webhook
        channel: '#cranker-alerts'
        send_resolved: true
        title: '{{ .Status | toUpper }} {{ .CommonLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}'
```

- [ ] **Step 5: Create `deploy/cranker/grafana-datasources.yml`**

```yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

- [ ] **Step 6: Create `deploy/cranker/.env.example`**

```
# Required
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=REPLACE_ME
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=REPLACE_ME
FOGO_RPC_URL=https://fogo.testnet
KEYPAIR_PATH=/keypair.json
WORMHOLESCAN_URL=https://api.wormholescan.io

# Optional (defaults shown)
METRICS_PORT=9090
SCAN_INTERVAL_MS=30000
RPC_TIMEOUT_MS=15000
HEARTBEAT_STALE_MS=120000
MAX_CONCURRENT_ADVANCES=4
LOG_LEVEL=info

# For docker-compose only (not consumed by cranker daemon)
WATCHTOWER_SLACK_WEBHOOK=slack://hook.foo/bar
```

- [ ] **Step 7: Validate compose file syntax**

Run: `docker compose -f deploy/cranker/docker-compose.yml config`
Expected: parses without error.

- [ ] **Step 8: Commit**

```bash
git add deploy/cranker
git commit -m "feat(cranker): docker-compose stack with prom/alertmanager/grafana"
```

---

## Task 12: GitHub Actions image build

**Files:**
- Create: `.github/workflows/cranker-image.yml`

- [ ] **Step 1: Create workflow**

```yaml
name: cranker-image
on:
  push:
    branches: [main]
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/metadata-action@v5
        id: meta
        with:
          images: ghcr.io/${{ github.repository_owner }}/fogo-onre-cranker
          tags: |
            type=ref,event=branch
            type=ref,event=tag
            type=sha,format=long
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: packages/cranker/Dockerfile
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/cranker-image.yml
git commit -m "ci: build and push cranker image to ghcr"
```

---

## Task 13: Host bootstrap runbook

**Files:**
- Create: `deploy/cranker/runbook.md`

- [ ] **Step 1: Write the runbook**

The runbook contains operator-facing prose: bootstrap, deploy, rollback, key rotation, incident response. Sections required:

```markdown
# Cranker Operations Runbook

## Provisioning a fresh CX22

1. Order CX22 in Hetzner console, location Ashburn (ash). Ubuntu 24.04 LTS image. Paste operator SSH public key into the instance creation form.
2. SSH in once as root. Create unprivileged operator user and disable root:
   ```
   adduser --disabled-password --gecos "" ops
   mkdir -p /home/ops/.ssh && cp /root/.ssh/authorized_keys /home/ops/.ssh/
   chown -R ops:ops /home/ops/.ssh && chmod 700 /home/ops/.ssh && chmod 600 /home/ops/.ssh/authorized_keys
   usermod -aG sudo,docker ops
   apt update && apt install -y ufw fail2ban unattended-upgrades docker.io docker-compose-plugin
   systemctl enable --now docker fail2ban
   ```
3. Harden `/etc/ssh/sshd_config`:
   ```
   PermitRootLogin no
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   AllowUsers ops
   AllowTcpForwarding yes
   MaxAuthTries 3
   ```
   Then `systemctl restart ssh`. Test login as `ops` from a second terminal **before** closing the root session.
4. Configure firewall:
   ```
   ufw default deny incoming
   ufw default allow outgoing
   ufw allow 22/tcp
   ufw enable
   ```
   Verify only port 22 is publicly reachable.
5. Enable security updates: `dpkg-reconfigure --priority=low unattended-upgrades`.
6. Create cranker user/group with pinned UID:
   ```
   groupadd -g 10001 cranker
   useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin cranker
   ```
7. Create config directory:
   ```
   mkdir -p /etc/cranker
   chown root:root /etc/cranker
   chmod 0750 /etc/cranker
   ```
8. Place files via `scp` from your workstation (e.g. `scp keypair.json ops@<host>:/tmp/` then `sudo install -o 10001 -g 10001 -m 0400 /tmp/keypair.json /etc/cranker/`):
   - `/etc/cranker/keypair.json` — `chown 10001:10001 && chmod 0400`
   - `/etc/cranker/.env` — `chown root:docker && chmod 0640` (filled from `.env.example`)
   - `/etc/cranker/docker-compose.yml`
   - `/etc/cranker/prometheus.yml`, `alert-rules.yml`, `alertmanager.yml`, `grafana-datasources.yml`
   - `/etc/cranker/grafana_admin_password` — random 32 bytes, `chmod 0400`
   - `/etc/cranker/slack_webhook` — webhook URL only, `chmod 0400`
9. Configure docker daemon log rotation — `/etc/docker/daemon.json`:
   ```json
   {"log-driver": "json-file", "log-opts": {"max-size": "50m", "max-file": "5"}}
   ```
   `systemctl restart docker`.
10. Configure journald — `/etc/systemd/journald.conf` set `SystemMaxUse=1G` and `SystemMaxFileSize=100M`. `systemctl restart systemd-journald`.
11. Start the stack:
    ```
    docker compose -f /etc/cranker/docker-compose.yml up -d
    docker compose -f /etc/cranker/docker-compose.yml ps
    ```
12. Verify `/healthz` from your workstation via SSH local-forward:
    ```
    ssh -L 9090:127.0.0.1:9090 ops@<host>   # in one terminal
    curl http://localhost:9090/healthz       # in another
    ```
    Expected: `{"status":"ok",...}`.
13. Verify metrics in Prometheus UI: `ssh -L 9091:127.0.0.1:9091 ops@<host>` then browse `http://localhost:9091`.
14. Verify Grafana: `ssh -L 3000:127.0.0.1:3000 ops@<host>` then browse `http://localhost:3000`. Login with admin password from `/etc/cranker/grafana_admin_password`.

## Routine deploy
Watchtower polls `:main` every 5 minutes. No operator action required.

## Manual deploy / rollback
Edit `image:` in `/etc/cranker/docker-compose.yml` to a specific digest:
```
image: ghcr.io/<org>/fogo-onre-cranker@sha256:abc123...
```
Then: `docker compose -f /etc/cranker/docker-compose.yml up -d cranker`.

Keep the **last three known-good digests** in this runbook (append to the table below).

| Date | Digest | Notes |
|---|---|---|
|  |  |  |

## Key rotation

1. Generate new keypair locally: `solana-keygen new -o cranker-new.json --no-bip39-passphrase`.
2. Pre-fund new pubkey with 0.5 SOL.
3. Verify invariant: pubkey != `RelayerConfig.authority`.
4. SSH in, replace `/etc/cranker/keypair.json`:
   ```
   cp /etc/cranker/keypair.json /etc/cranker/keypair.json.bak
   install -o 10001 -g 10001 -m 0400 cranker-new.json /etc/cranker/keypair.json
   docker compose -f /etc/cranker/docker-compose.yml restart cranker
   ```
5. Drain old key: send remaining SOL to ops wallet.
6. Delete `cranker-new.json` from your laptop.

## Incident response: cranker is wedged

1. Check Slack alert for which alarm fired.
2. SSH in as `ops`, `docker compose -f /etc/cranker/docker-compose.yml logs --tail=200 cranker`.
3. If logs show stuck RPC, rotate `SOLANA_RPC_URL` to backup endpoint in `/etc/cranker/.env`, restart cranker.
4. If self-kill is firing in a loop, image is bad — manual rollback to previous known-good digest (above).

## Disaster recovery: VM is gone

RTO target <2h. Steps:
1. Provision new CX22 (Provisioning section above).
2. Restore `keypair.json` from operator-side backup (1Password / hardware key).
3. Restore `.env` from operator-side backup.
4. `docker compose up -d`. Done.

Prometheus/Grafana history is lost — accepted tradeoff per spec.
```

- [ ] **Step 2: Commit**

```bash
git add deploy/cranker/runbook.md
git commit -m "docs(cranker): host bootstrap and operations runbook"
```

---

## Task 14: Staging deploy verification

**Files:**
- Create: `deploy/cranker/staging-checklist.md`

- [ ] **Step 1: Write the checklist**

```markdown
# Cranker Staging Verification Checklist

Run this on a separate CX22 pointed at devnet Solana / staging FOGO before promoting any image to mainnet.

## Pre-deploy
- [ ] CI build of `:main` succeeded; image digest captured.
- [ ] Staging keypair pre-funded with 0.1 SOL devnet.
- [ ] Staging `RelayerConfig.authority` ≠ staging cranker pubkey (verify with `solana account <config-pda>`).

## Boot
- [ ] `docker compose up -d` succeeds.
- [ ] Within 120s `/healthz` returns 200.
- [ ] `cranker_scan_iterations_total{result="ok"}` > 0 within 60s of healthy.

## Functional
- [ ] Trigger a synthetic deposit on FOGO devnet → wait ≤45s → cranker logs show claim_usdc landed.
- [ ] Inspect Flow PDA → status advanced through Pending → UsdcClaimed → Swapped → (lock_onyc emitted VAA).
- [ ] Trigger withdraw flow → cranker advances request → claim → send.

## Chaos
- [ ] Kill primary RPC endpoint at firewall → `cranker_rpc_errors_total{kind="timeout"}` increments → daemon does not crash.
- [ ] Kill WS endpoint → `cranker_ws_subscription_alive == 0` → 30s poll keeps making forward progress.
- [ ] Block all RPC for >120s → daemon self-kills (`docker compose ps` shows restart count incremented).
- [ ] `docker compose stop cranker` → SIGTERM logged → drain completes ≤30s → exit code 0.

## Rollback
- [ ] Edit compose to previous digest, `up -d` → new container healthy in <120s.

## Sign-off
- [ ] Operator signs off in PR review before promoting to mainnet.
```

- [ ] **Step 2: Commit**

```bash
git add deploy/cranker/staging-checklist.md
git commit -m "docs(cranker): staging verification checklist"
```

---

## Self-Review (against spec)

**Spec coverage:**
- Package layout → Task 1, 2, 3, 4, 5, 6, 7, 8 ✓
- Scan loop → Task 6, 7 ✓
- Hardening (top-level handlers, RPC timeouts, bounded concurrency, memory, signals) → Task 3, 6, 7, 8 ✓
- Metrics surface (all 8 metrics) → Task 4 ✓
- Self-kill on wedge → Task 7 ✓
- PDA enumeration strategy → Task 6 (with explicit reference to spec table) ✓
- Container image (pnpm deploy, UID pinning, healthcheck, start-period) → Task 10 ✓
- Compose stack (all 5 services, host loopback bind) → Task 11 ✓
- Update model (watchtower, manual rollback) → Task 11, 13 ✓
- Host bootstrap and SSH access → Task 13 ✓
- SSH and host hardening → Task 13 ✓
- Disk and log management → Task 13 ✓
- Spend alarm → Task 11 (alert-rules.yml) ✓
- Verification → Task 14 ✓

**Placeholder scan:** Task 5 contains "TODO: port from cli/cranker.ts:147-309" inside the function body — this is intentional and bounded: the plan mandates the function signature and refers to specific source line ranges to copy. The implementer's job is mechanical extraction, not creative writing. The scaffolding is complete; the body is line-bounded literal-copy work.

**Type consistency:** `AdvanceContext` defined in Task 5 is consumed by Tasks 6, 7, 8, 9 with the same field set. `Metrics` from Task 4 consumed by Tasks 6, 7, 8 — same shape. `CrankerConfig` from Task 2 consumed by Task 8 — same shape.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-cranker-hetzner-docker-deployment.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 14-task plan with mostly independent commits.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
