import { findNttEmitterPda, FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID } from '@fogo-onre/sdk'
import { z } from 'zod'

// Defaults derived from the SDK so the cranker stays in lockstep with
// the published manager program IDs and chain ID. Single source of truth.
const [DEFAULT_USDC_EMITTER] = findNttEmitterPda(NTT_USDC_PROGRAM_ID)
const [DEFAULT_ONYC_EMITTER] = findNttEmitterPda(NTT_ONYC_PROGRAM_ID)
const DEFAULT_USDC_EMITTER_HEX = Buffer.from(DEFAULT_USDC_EMITTER.toBytes()).toString('hex')
const DEFAULT_ONYC_EMITTER_HEX = Buffer.from(DEFAULT_ONYC_EMITTER.toBytes()).toString('hex')
// Solana ONyc manager and FOGO ONyc manager share the same NTT v3 binary
// and program id (same bytecode deployed on both chains), so the source
// emitter for outbound Solana → FOGO ONyc VAAs derives from the same
// `NTT_ONYC_PROGRAM_ID` constant.
const DEFAULT_SOLANA_ONYC_EMITTER_HEX = DEFAULT_ONYC_EMITTER_HEX

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
  /**
   * Hex emitter for the Solana ONyc NTT manager. Outbound source for the bridge pipeline.
   *  Defaults to PDA derived from SDK's NTT_ONYC_PROGRAM_ID (same bytecode as FOGO side).
   */
  SOLANA_ONYC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_SOLANA_ONYC_EMITTER_HEX),
  /** Set to "false" to disable the Solana → FOGO ONyc bridge pipeline (e.g. during incident triage). */
  BRIDGE_PIPELINE_ENABLED: z.enum(['true', 'false']).default('true'),
  /** Bridge-side concurrency budget — separate from MAX_CONCURRENT_ADVANCES so a Wormholescan backfill can't starve normal Flow advances. */
  BRIDGE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(4),
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9090),
  SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),
  SCAN_MAX_BACKOFF_MS: z.coerce.number().int().min(1000).default(300_000),
  SHUTDOWN_DEADLINE_MS: z.coerce.number().int().min(1000).default(8000),
  BALANCE_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(60_000),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  /**
   * Budget for a single `enumerateFlows` call (Wormholescan paging +
   * per-VAA Flow PDA lookups). Separate from `RPC_TIMEOUT_MS` because
   * a fresh process with no checkpoint must backfill the full page
   * window — easily 50–100 round-trips — and 15s isn't enough.
   */
  ENUMERATE_TIMEOUT_MS: z.coerce.number().int().min(5000).default(90_000),
  TX_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60_000),
  WORMHOLESCAN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  HEARTBEAT_STALE_MS: z.coerce.number().int().min(30_000).default(120_000),
  MAX_CONCURRENT_ADVANCES: z.coerce.number().int().min(1).max(32).default(4),
  /**
   * Path to the on-disk checkpoint file (per-emitter Wormholescan
   * watermarks). Empty string disables persistence — in-memory
   * watermarks still apply within a process lifetime. Idempotency
   * on-chain means a lost checkpoint just causes a one-time backfill,
   * never a missed dispatch.
   */
  CHECKPOINT_PATH: z.string().default('./cranker-checkpoint.json'),
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
  solanaOnycEmitterHex: string
  bridgePipelineEnabled: boolean
  bridgeMaxConcurrent: number
  metricsPort: number
  scanIntervalMs: number
  scanMaxBackoffMs: number
  shutdownDeadlineMs: number
  balancePollIntervalMs: number
  rpcTimeoutMs: number
  enumerateTimeoutMs: number
  txConfirmTimeoutMs: number
  wormholescanTimeoutMs: number
  heartbeatStaleMs: number
  maxConcurrentAdvances: number
  checkpointPath: string
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
    solanaOnycEmitterHex: parsed.SOLANA_ONYC_EMITTER_HEX,
    bridgePipelineEnabled: parsed.BRIDGE_PIPELINE_ENABLED === 'true',
    bridgeMaxConcurrent: parsed.BRIDGE_MAX_CONCURRENT,
    metricsPort: parsed.METRICS_PORT,
    scanIntervalMs: parsed.SCAN_INTERVAL_MS,
    scanMaxBackoffMs: parsed.SCAN_MAX_BACKOFF_MS,
    shutdownDeadlineMs: parsed.SHUTDOWN_DEADLINE_MS,
    balancePollIntervalMs: parsed.BALANCE_POLL_INTERVAL_MS,
    rpcTimeoutMs: parsed.RPC_TIMEOUT_MS,
    enumerateTimeoutMs: parsed.ENUMERATE_TIMEOUT_MS,
    txConfirmTimeoutMs: parsed.TX_CONFIRM_TIMEOUT_MS,
    wormholescanTimeoutMs: parsed.WORMHOLESCAN_TIMEOUT_MS,
    heartbeatStaleMs: parsed.HEARTBEAT_STALE_MS,
    maxConcurrentAdvances: parsed.MAX_CONCURRENT_ADVANCES,
    checkpointPath: parsed.CHECKPOINT_PATH,
    logLevel: parsed.LOG_LEVEL,
  }
}
