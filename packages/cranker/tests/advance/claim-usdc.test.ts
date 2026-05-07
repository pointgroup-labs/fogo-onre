import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import * as advance from '../../src/advance'

// Light structural tests for the advance barrel. Full happy-path
// integration tests for claimUsdc/swapUsdcToOnyc/lockOnyc require a
// LiteSVM mock rig and live in Task 6 alongside the scan dispatcher.

describe('advance barrel', () => {
  it('exports all seven advance functions', () => {
    expect(typeof advance.claimUsdc).toBe('function')
    expect(typeof advance.swapUsdcToOnyc).toBe('function')
    expect(typeof advance.lockOnyc).toBe('function')
    expect(typeof advance.unlockOnyc).toBe('function')
    expect(typeof advance.requestRedemption).toBe('function')
    expect(typeof advance.claimRedemption).toBe('function')
    expect(typeof advance.sendUsdcToUser).toBe('function')
  })
})

describe('withdraw-chain stubs', () => {
  // Withdraw modules are deferred until the FOGO ONyc NTT manager is
  // published (CLAUDE.md). They must surface that gracefully as
  // `kind: 'error'` so the daemon logs but doesn't crash if the scan
  // dispatcher routes a withdraw VAA to one of these.
  const ctx = {} as Parameters<typeof advance.unlockOnyc>[0]

  it('unlockOnyc returns error: not implemented', async () => {
    const dummyMint = new PublicKey('11111111111111111111111111111111')
    const res = await advance.unlockOnyc(ctx, { fogoTx: 'x', onycMint: dummyMint })
    expect(res.kind).toBe('error')
    if (res.kind === 'error') {
      expect(res.error.message).toMatch(/not implemented/)
    }
  })

  it('requestRedemption returns error: not implemented', async () => {
    const dummyPk = new PublicKey('11111111111111111111111111111111')
    const res = await advance.requestRedemption(ctx, { nttInboxItem: dummyPk })
    expect(res.kind).toBe('error')
  })

  it('claimRedemption returns error: not implemented', async () => {
    const dummyPk = new PublicKey('11111111111111111111111111111111')
    const res = await advance.claimRedemption(ctx, {
      nttInboxItem: dummyPk,
      redemptionRequest: dummyPk,
    })
    expect(res.kind).toBe('error')
  })

  it('sendUsdcToUser returns error: not implemented', async () => {
    const dummyPk = new PublicKey('11111111111111111111111111111111')
    const res = await advance.sendUsdcToUser(ctx, { nttInboxItem: dummyPk })
    expect(res.kind).toBe('error')
  })
})
