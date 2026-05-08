import type { Connection, PublicKey } from '@solana/web3.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { startBalancePoller } from '../src/index'
import { createMetrics } from '../src/metrics'

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
type CloseCallback = (err?: Error) => void

let requestHandler: RequestHandler | undefined

vi.mock('node:http', () => ({
  createServer: vi.fn((handler: RequestHandler) => {
    requestHandler = handler
    const server = {
      listen: (_port: number, _host: string, callback: () => void) => {
        callback()
        return server
      },
      address: () => ({ port: 12345 }),
      close: (callback: CloseCallback) => {
        callback()
        return server
      },
    }
    return server
  }),
}))

async function request(url: string): Promise<{ statusCode: number, body: string, headers: Record<string, string> }> {
  if (!requestHandler) {
    throw new Error('metrics server was not started')
  }
  let body = ''
  const headers: Record<string, string> = {}
  const req = { url } as IncomingMessage
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: number | string | readonly string[]) => {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
    },
    end: (chunk?: string | Uint8Array) => {
      if (chunk !== undefined) {
        body += chunk.toString()
      }
    },
  } as ServerResponse

  await requestHandler(req, res)
  return { statusCode: res.statusCode, body, headers }
}

describe('createMetrics', () => {
  it('starts http server, exposes /metrics and /healthz', async () => {
    const m = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    await m.start()
    const port = m.actualPort()

    m.heartbeat.setNow()
    const healthRes = await request('/healthz')
    expect(port).toBe(12345)
    expect(healthRes.statusCode).toBe(200)

    const metricsRes = await request('/metrics')
    expect(metricsRes.statusCode).toBe(200)
    expect(metricsRes.body).toMatch(/cranker_scan_iterations_total/)

    await m.stop()
  })

  it('healthz returns 503 when heartbeat is stale', async () => {
    const m = createMetrics({ port: 0, heartbeatStaleMs: 100 })
    await m.start()

    m.heartbeat.setAt(Date.now() - 200)
    const res = await request('/healthz')
    expect(res.statusCode).toBe(503)

    await m.stop()
  })

  it('exposes per-chain balance + poll-age gauges; age starts at +Inf', async () => {
    const m = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    await m.start()
    const res = await request('/metrics')
    expect(res.body).toMatch(/cranker_keypair_sol_balance/)
    expect(res.body).toMatch(/cranker_keypair_fogo_balance/)
    // Age before any successful poll is +Inf, encoded by prom-client as `+Inf`.
    expect(res.body).toMatch(/cranker_balance_poll_age_seconds\{chain="solana"\} \+Inf/)
    expect(res.body).toMatch(/cranker_balance_poll_age_seconds\{chain="fogo"\} \+Inf/)
    await m.stop()
  })

  it('recordBalancePollSuccess turns +Inf age into a finite value', async () => {
    const m = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    await m.start()
    m.recordBalancePollSuccess('solana')
    const res = await request('/metrics')
    // Solana age finite; FOGO untouched (still +Inf).
    expect(res.body).toMatch(/cranker_balance_poll_age_seconds\{chain="solana"\} 0(\.\d+)?\n/)
    expect(res.body).toMatch(/cranker_balance_poll_age_seconds\{chain="fogo"\} \+Inf/)
    await m.stop()
  })
})

describe('startBalancePoller', () => {
  function makeConn(getBalance: () => Promise<number>): Connection {
    return { getBalance } as unknown as Connection
  }
  const pubkey = { toBase58: () => 'k' } as unknown as PublicKey
  const log = { warn: () => undefined } as never

  it('sets the balance gauge on success and stamps the age', async () => {
    const m = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    const ac = new AbortController()
    startBalancePoller({
      chain: 'fogo',
      connection: makeConn(async () => 2_500_000_000), // 2.5 SOL
      pubkey,
      metrics: m,
      intervalMs: 60_000,
      log,
      signal: ac.signal,
    })
    // Initial tick is async; let microtasks settle.
    await new Promise(r => setTimeout(r, 5))
    const fogo = await m.fogoBalance.get()
    expect(fogo.values[0].value).toBe(2.5)
    ac.abort()
  })

  it('sets the balance gauge to NaN on RPC failure (so the alert fires)', async () => {
    const m = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    const ac = new AbortController()
    startBalancePoller({
      chain: 'solana',
      connection: makeConn(async () => {
        throw new Error('rpc down')
      }),
      pubkey,
      metrics: m,
      intervalMs: 60_000,
      log,
      signal: ac.signal,
    })
    await new Promise(r => setTimeout(r, 5))
    const sol = await m.solBalance.get()
    expect(Number.isNaN(sol.values[0].value)).toBe(true)
    // Companion: rpc-error counter ticked under the chain endpoint label.
    const errs = await m.rpcErrors.get()
    const e = errs.values.find(v => v.labels.endpoint === 'solana' && v.labels.kind === 'getBalance')
    expect(e?.value).toBe(1)
    ac.abort()
  })
})
