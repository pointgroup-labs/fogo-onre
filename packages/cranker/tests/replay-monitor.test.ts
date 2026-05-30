import { findIntentTransferSetterPda, INTENT_TRANSFER_PROGRAM_ID, ONRE_INTENT_PROGRAM_ID } from '@fogo-onre/sdk'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { createMetrics } from '../src/metrics'
import { flagDormantSetterReplay } from '../src/relayer/replay-monitor'
import { silentLogger } from '../src/utils/log'

const DORMANT_SETTER = findIntentTransferSetterPda(INTENT_TRANSFER_PROGRAM_ID)[0]
const ACTIVE_SETTER = findIntentTransferSetterPda(ONRE_INTENT_PROGRAM_ID)[0]

async function replayCount(metrics: ReturnType<typeof createMetrics>, leg: string): Promise<number> {
  const series = await metrics.intentReplayObserved.get()
  return series.values.find(v => v.labels.leg === leg)?.value ?? 0
}

describe('flagDormantSetterReplay', () => {
  it('flags and counts a sender equal to the dormant (Fogo) setter', async () => {
    const metrics = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    const flagged = flagDormantSetterReplay({
      senderOnSource: DORMANT_SETTER,
      leg: 'deposit',
      metrics,
      log: silentLogger(),
    })
    expect(flagged).toBe(true)
    expect(await replayCount(metrics, 'deposit')).toBe(1)
  })

  it('does not flag the active (OnRe fork) setter', async () => {
    const metrics = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    const flagged = flagDormantSetterReplay({
      senderOnSource: ACTIVE_SETTER,
      leg: 'withdraw',
      metrics,
      log: silentLogger(),
    })
    expect(flagged).toBe(false)
    expect(await replayCount(metrics, 'withdraw')).toBe(0)
  })

  it('does not flag an arbitrary sender', async () => {
    const metrics = createMetrics({ port: 0, heartbeatStaleMs: 90_000 })
    const flagged = flagDormantSetterReplay({
      senderOnSource: Keypair.generate().publicKey,
      leg: 'deposit',
      metrics,
      log: silentLogger(),
    })
    expect(flagged).toBe(false)
    expect(await replayCount(metrics, 'deposit')).toBe(0)
  })
})
