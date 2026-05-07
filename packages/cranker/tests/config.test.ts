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
