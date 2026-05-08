import { describe, expect, it } from 'vitest'
import * as advance from '../../src/advance'

// Light structural tests for the advance barrel. Full happy-path
// integration tests for claimUsdc/swapUsdcToOnyc/lockOnyc require a
// LiteSVM mock rig and live in Task 6 alongside the scan dispatcher.

describe('advance barrel', () => {
  it('exports the deposit-chain advance functions', () => {
    expect(typeof advance.claimUsdc).toBe('function')
    expect(typeof advance.swapUsdcToOnyc).toBe('function')
    expect(typeof advance.lockOnyc).toBe('function')
  })
})
