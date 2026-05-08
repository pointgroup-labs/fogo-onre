import { findNttEmitterPda, FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID } from '@fogo-onre/sdk'
import { z } from 'zod'

// Defaults derived from the SDK so the cranker stays in lockstep with
// the published manager program IDs and chain ID. Single source of truth.
const [DEFAULT_USDC_EMITTER] = findNttEmitterPda(NTT_USDC_PROGRAM_ID)
const [DEFAULT_ONYC_EMITTER] = findNttEmitterPda(NTT_ONYC_PROGRAM_ID)
const DEFAULT_USDC_EMITTER_HEX = Buffer.from(DEFAULT_USDC_EMITTER.toBytes()).toString('hex')
const DEFAULT_ONYC_EMITTER_HEX = Buffer.from(DEFAULT_ONYC_EMITTER.toBytes()).toString('hex')

const schema = z.object({
  SOLANA_RPC_URL: z.string().url().refine(
    u => !u.includes('api.mainnet-beta.solana.com'),
    { message: 'public mainnet-beta RPC disabled getProgramAccounts; use a paid RPC (Helius/QuickNode/Triton)' },
  ),
  SOLANA_WS_URL: z.string().url(),
  FOGO_RPC_URL: z.string().url(),
  KEYPAIR_PATH: z.string().min(1),
  WORMHOLESCAN_URL: z.string().url().default('https://api.wormholescan.io'),
  WORMHOLESCAN_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(50),
  WORMHOLESCAN_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(2),
  /** FOGO Wormhole chain ID (source chain for VAA polling). Defaults to SDK constant. */
  FOGO_WORMHOLE_CHAIN_ID: z.coerce.number().int().min(1).default(FOGO_WORMHOLE_CHAIN_ID),
  /** Hex emitter (32 bytes, no 0x) for the FOGO USDC NTT manager. Defaults to PDA derived from SDK's NTT_USDC_PROGRAM_ID. */
  FOGO_USDC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_USDC_EMITTER_HEX),
  /** Hex emitter for the FOGO ONyc NTT manager. Defaults to PDA derived from SDK's NTT_ONYC_PROGRAM_ID. */
  FOGO_ONYC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_ONYC_EMITTER_HEX),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9090),
  SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  SCAN_MAX_BACKOFF_MS: z.coerce.number().int().min(1000).default(300_000),
  SHUTDOWN_DEADLINE_MS: z.coerce.number().int().min(1000).default(8000),
  BALANCE_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(60_000),
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
  wormholescanPageSize: number
  wormholescanMaxPages: number
  fogoWormholeChainId: number
  fogoUsdcEmitterHex: string
  fogoOnycEmitterHex: string
  metricsPort: number
  scanIntervalMs: number
  scanMaxBackoffMs: number
  shutdownDeadlineMs: number
  balancePollIntervalMs: number
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
    wormholescanPageSize: parsed.WORMHOLESCAN_PAGE_SIZE,
    wormholescanMaxPages: parsed.WORMHOLESCAN_MAX_PAGES,
    fogoWormholeChainId: parsed.FOGO_WORMHOLE_CHAIN_ID,
    fogoUsdcEmitterHex: parsed.FOGO_USDC_EMITTER_HEX,
    fogoOnycEmitterHex: parsed.FOGO_ONYC_EMITTER_HEX,
    metricsPort: parsed.METRICS_PORT,
    scanIntervalMs: parsed.SCAN_INTERVAL_MS,
    scanMaxBackoffMs: parsed.SCAN_MAX_BACKOFF_MS,
    shutdownDeadlineMs: parsed.SHUTDOWN_DEADLINE_MS,
    balancePollIntervalMs: parsed.BALANCE_POLL_INTERVAL_MS,
    rpcTimeoutMs: parsed.RPC_TIMEOUT_MS,
    wormholescanTimeoutMs: parsed.WORMHOLESCAN_TIMEOUT_MS,
    heartbeatStaleMs: parsed.HEARTBEAT_STALE_MS,
    maxConcurrentAdvances: parsed.MAX_CONCURRENT_ADVANCES,
    logLevel: parsed.LOG_LEVEL,
  }
}
