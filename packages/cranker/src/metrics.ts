import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client'

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
  const flowSkipped = new Counter({
    name: 'cranker_flow_skipped_total',
    help: 'Flows seen by the scanner with statuses the cranker cannot advance',
    labelNames: ['reason'] as const,
    registers: [registry],
  })
  const flowUnsweptObserved = new Counter({
    name: 'cranker_flow_unswept_observed_total',
    help: 'Per-scan observations of a flow whose NTT inbox-item is Released but whose unlocked tokens are still parked in the recipient ATA (raw redeem done, relayer receive not yet swept). A healthy sweep clears within a scan or two, so this barely moves; sustained growth (rate > 0 for several minutes) means a wedged receive/swap/send and a likely stranded user deposit/withdraw.',
    labelNames: ['leg'] as const,
    registers: [registry],
  })
  const intentReplayObserved = new Counter({
    name: 'cranker_intent_replay_observed_total',
    help: 'Inbound VAAs whose NTT sender is the dormant intent program\'s setter PDA — a cross-program replay signal (still on-chain-accepted via the {OnRe,Fogo} allowlist, so this is observational only). Any nonzero value warrants investigation.',
    labelNames: ['leg'] as const,
    registers: [registry],
  })
  const bridgeRedeemed = new Counter({
    name: 'cranker_bridge_redeemed_total',
    help: 'Outcome of bridge VAA redeem attempts (decoupled from relayer Flow advances)',
    labelNames: ['target', 'result'] as const,
    registers: [registry],
  })
  const bridgeScanIterations = new Counter({
    name: 'cranker_bridge_scan_iterations_total',
    help: 'Bridge pipeline scan iterations',
    labelNames: ['target', 'result'] as const,
    registers: [registry],
  })
  const solBalance = new Gauge({
    name: 'cranker_keypair_sol_balance',
    help: 'Cranker keypair SOL balance on Solana (lamports / 1e9). NaN during RPC outage so the low-balance alert fires instead of holding the last good value.',
    registers: [registry],
  })
  const fogoBalance = new Gauge({
    name: 'cranker_keypair_fogo_balance',
    help: 'Cranker keypair native-token balance on FOGO (lamports / 1e9). The same keypair pays bridge-redeem fees on FOGO; if this hits zero, all Solana → FOGO ONyc redeems start failing silently. NaN during RPC outage.',
    registers: [registry],
  })
  // Per-chain poll-age, evaluated at scrape time from `lastBalancePollSuccess`.
  // Lets a Prometheus alert distinguish "balance gauge is NaN because the
  // chain is down" from "balance gauge is NaN because the poller never ran"
  // — the age keeps growing in the first case and stays at +Inf in the second.
  const lastBalancePollSuccess: Record<'solana' | 'fogo', number | undefined> = {
    solana: undefined,
    fogo: undefined,
  }
  const balancePollAge = new Gauge({
    name: 'cranker_balance_poll_age_seconds',
    help: 'Seconds since the last successful balance poll, per chain. +Inf when the poller has never succeeded.',
    labelNames: ['chain'] as const,
    registers: [registry],
    collect() {
      for (const chain of ['solana', 'fogo'] as const) {
        const ts = lastBalancePollSuccess[chain]
        const age = ts === undefined ? Number.POSITIVE_INFINITY : (Date.now() - ts) / 1000
        this.set({ chain }, age)
      }
    },
  })
  const wsAlive = new Gauge({
    name: 'cranker_ws_subscription_alive',
    help: 'WebSocket subscription health (1=alive, 0=dead)',
    registers: [registry],
  })
  // Pull-model so the gauge never goes stale: the provider is the live
  // FlowStateTracker, read at scrape time. `poisoned` is the alertable
  // signal — a flow stranded by a persistent upstream wedge (OnRe vector
  // deletion, NTT/manager pause). If upstream is permanently gone, only an
  // upgrade-authority rescue can move the funds (docs/security.md §3).
  let stuckFlowProvider: (() => { poisoned: number, cooldown: number }) | undefined
  const flowStuck = new Gauge({
    name: 'cranker_flow_stuck',
    help: 'Flows the cranker cannot advance: state="poisoned" (quarantined past the retry threshold — alert on any nonzero) or state="cooldown" (self-healing backoff).',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      const c = stuckFlowProvider?.() ?? { poisoned: 0, cooldown: 0 }
      this.set({ state: 'poisoned' }, c.poisoned)
      this.set({ state: 'cooldown' }, c.cooldown)
    },
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
    flowSkipped,
    flowUnsweptObserved,
    intentReplayObserved,
    bridgeRedeemed,
    bridgeScanIterations,
    solBalance,
    fogoBalance,
    balancePollAge,
    /**
     * Stamp a successful balance poll so `cranker_balance_poll_age_seconds`
     * resets to ~0 on the next scrape. The poller calls this *only* on a
     * successful `getBalance` — failures leave the timestamp untouched so
     * age grows naturally and the alert fires.
     */
    recordBalancePollSuccess(chain: 'solana' | 'fogo'): void {
      lastBalancePollSuccess[chain] = Date.now()
    },
    wsAlive,
    flowStuck,

    /**
     * Wire the live FlowStateTracker so `cranker_flow_stuck` reflects
     * quarantined/cooling flows at scrape time. Called once at startup.
     */
    setStuckFlowProvider(fn: () => { poisoned: number, cooldown: number }): void {
      stuckFlowProvider = fn
    },

    actualPort: () => actualPort,

    async start() {
      if (server) {
        // Idempotent: a second start() is a no-op rather than orphaning the
        // first listener.
        return
      }
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
