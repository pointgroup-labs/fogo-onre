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
