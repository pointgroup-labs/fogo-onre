import type { AdvanceContext } from '../../src/relayer/types'
import type { Logger } from '../../src/utils/log'
import { REFUND_TIMEOUT_SLOTS } from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it, vi } from 'vitest'
import { refundDue } from '../../src/relayer/refund'
import { scanAndRefund } from '../../src/relayer/refund-scan'
import { silentLogger } from '../../src/utils/log'

function makeCtx(): AdvanceContext {
  return {
    abortSignal: new AbortController().signal,
    log: silentLogger() satisfies Logger,
  } as unknown as AdvanceContext
}

const PUBKEY = new PublicKey('11111111111111111111111111111111')

describe('refundDue', () => {
  it('is false before received_slot + REFUND_TIMEOUT_SLOTS', () => {
    expect(refundDue(1_000n, 1_000n + REFUND_TIMEOUT_SLOTS - 1n)).toBe(false)
  })

  it('is true at exactly received_slot + REFUND_TIMEOUT_SLOTS', () => {
    expect(refundDue(1_000n, 1_000n + REFUND_TIMEOUT_SLOTS)).toBe(true)
  })

  it('is true well past the timeout', () => {
    expect(refundDue(1_000n, 1_000n + REFUND_TIMEOUT_SLOTS + 10_000n)).toBe(true)
  })
})

describe('scanAndRefund', () => {
  it('dispatches refund only for Received flows', async () => {
    const refundFn = vi.fn().mockResolvedValue({ kind: 'noop', reason: 'not due' })
    await scanAndRefund(makeCtx(), {
      maxConcurrentRefunds: 2,
      rpcTimeoutMs: 5000,
      enumerateFlows: async () => [
        { pubkey: PUBKEY, status: 'Received', direction: 'withdraw', fogoTx: 'tx-A' },
        { pubkey: PUBKEY, status: 'Swapped', direction: 'deposit', fogoTx: 'tx-B' },
        { pubkey: PUBKEY, status: 'Pending', direction: 'deposit', fogoTx: 'tx-C' },
        { pubkey: PUBKEY, status: 'Received', direction: 'deposit', fogoTx: 'tx-D' },
        { pubkey: PUBKEY, status: 'Closed', direction: 'withdraw', fogoTx: 'tx-E' },
      ],
      refundFn,
    })
    expect(refundFn).toHaveBeenCalledTimes(2)
    const dispatched = refundFn.mock.calls.map(c => c[1].fogoTx).sort()
    expect(dispatched).toEqual(['tx-A', 'tx-D'])
  })

  it('forwards direction + vaaHex to the refund handler', async () => {
    const refundFn = vi.fn().mockResolvedValue({ kind: 'noop', reason: 'not due' })
    await scanAndRefund(makeCtx(), {
      maxConcurrentRefunds: 2,
      rpcTimeoutMs: 5000,
      enumerateFlows: async () => [
        { pubkey: PUBKEY, status: 'Received', direction: 'withdraw', fogoTx: 'tx-A', vaaHex: 'deadbeef' },
      ],
      refundFn,
    })
    expect(refundFn).toHaveBeenCalledWith(
      expect.anything(),
      { fogoTx: 'tx-A', vaaHex: 'deadbeef', direction: 'withdraw' },
    )
  })

  it('is a no-op when no Received flows exist', async () => {
    const refundFn = vi.fn()
    await scanAndRefund(makeCtx(), {
      maxConcurrentRefunds: 2,
      rpcTimeoutMs: 5000,
      enumerateFlows: async () => [
        { pubkey: PUBKEY, status: 'Swapped', direction: 'deposit', fogoTx: 'tx-B' },
      ],
      refundFn,
    })
    expect(refundFn).not.toHaveBeenCalled()
  })
})
