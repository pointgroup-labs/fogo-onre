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
    flowSkipped,
    bridgeRedeemed,
    bridgeScanIterations,
    solBalance,
    wsAlive,

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
