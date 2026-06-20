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
// Same bytecode/program id on Solana and FOGO USDC.s legs, so the
// outbound source emitter for redeem VAAs derives from the SDK's
// `NTT_USDC_PROGRAM_ID` constant.
const DEFAULT_SOLANA_USDC_EMITTER_HEX = DEFAULT_USDC_EMITTER_HEX

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
  /**
   * Backstop scan depth: a periodic enumeration that ignores the watermark,
   * catching flows the incremental scan stranded — VAAs that arrived during
   * downtime (watermark fast-forwarded past them) or orphan Flow PDAs from a
   * failed post-watermark dispatch. 50×50 ≈ several days of mainnet volume.
   */
  WORMHOLESCAN_BACKSTOP_MAX_PAGES: z.coerce.number().int().min(1).max(200).default(50),
  /** Period between backstop sweeps. 0 disables. Default 5 minutes. */
  BACKSTOP_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000),
  /**
   * Period between refund sweeps: NTT-sends the original token back for
   * `Received` flows past `REFUND_TIMEOUT_SLOTS`. 0 disables (default: opt in
   * until the NTT send-back manager wiring is verified). Suggested ~15min.
   */
  REFUND_INTERVAL_MS: z.coerce.number().int().min(0).default(0),
  /** Refund-side concurrency budget — separate so it can't starve normal advances. */
  MAX_CONCURRENT_REFUNDS: z.coerce.number().int().min(1).max(32).default(2),
  /** FOGO Wormhole chain ID (source chain for VAA polling). Defaults to SDK constant. */
  FOGO_WORMHOLE_CHAIN_ID: z.coerce.number().int().min(1).default(FOGO_WORMHOLE_CHAIN_ID),
  /** Hex emitter (32 bytes, no 0x) for the FOGO USDC NTT manager. Defaults to PDA derived from SDK's NTT_USDC_PROGRAM_ID. */
  FOGO_USDC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_USDC_EMITTER_HEX),
  /** Hex emitter for the FOGO ONyc NTT manager. Defaults to PDA derived from SDK's NTT_ONYC_PROGRAM_ID. */
  FOGO_ONYC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_ONYC_EMITTER_HEX),
  /** Hex emitter for the Solana ONyc NTT manager — outbound bridge source. Defaults to the NTT_ONYC_PROGRAM_ID PDA. */
  SOLANA_ONYC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_SOLANA_ONYC_EMITTER_HEX),
  /**
   * Hex emitter for the Solana USDC.s NTT manager — source for the
   * redeem-completion leg. Defaults to the SDK's `NTT_USDC_PROGRAM_ID` PDA.
   */
  SOLANA_USDC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_SOLANA_USDC_EMITTER_HEX),
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
   * Budget for one `enumerateFlows` call. Separate from `RPC_TIMEOUT_MS`
   * because a fresh checkpoint-less process backfills the full page window
   * (50–100 round-trips) and 15s isn't enough.
   */
  ENUMERATE_TIMEOUT_MS: z.coerce.number().int().min(5000).default(90_000),
  /**
   * Per-transaction confirmation budget. The 30s floor is sized for the
   * `core.postVaa` multi-tx sequence (several `verify_signatures` + one
   * `post_vaa`); anything lower aborts mid-sequence and silently bricks
   * withdraw flows under congestion.
   */
  TX_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(90_000),
  WORMHOLESCAN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  HEARTBEAT_STALE_MS: z.coerce.number().int().min(30_000).default(120_000),
  MAX_CONCURRENT_ADVANCES: z.coerce.number().int().min(1).max(32).default(4),
  /**
   * Priority fee (µ-lamports/CU) prepended to every Solana tx. Without a
   * non-zero value mainnet leaders deprioritize the tx and the blockhash
   * expires before inclusion. Default 10_000 clears a moderately congested
   * mainnet; bump to 50_000+ during incidents (takes effect next scan).
   */
  SOLANA_PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().min(0).default(10_000),
  /**
   * Address Lookup Table compressing the `send` leg's stable NTT/Wormhole
   * accounts — required for the outbound tx to fit the 1232-byte limit (else
   * the v0 message inlines every account and overflows). Defaults to the live
   * mainnet send-leg LUT so a forgotten env var can't brick sends.
   */
  SEND_LOOKUP_TABLE: z.string().min(32).default('9aF7QN6HTtfQ6Wvo2UMFeTuHyaBxidMHhbTbN16Bwuyk'),
  /**
   * On-disk checkpoint file (per-emitter watermarks). Empty string disables
   * persistence (in-memory watermarks still apply per process). On-chain
   * idempotency makes a lost checkpoint a one-time backfill, never a missed
   * dispatch.
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
  wormholescanBackstopMaxPages: number
  backstopIntervalMs: number
  refundIntervalMs: number
  maxConcurrentRefunds: number
  fogoWormholeChainId: number
  fogoUsdcEmitterHex: string
  fogoOnycEmitterHex: string
  solanaOnycEmitterHex: string
  solanaUsdcEmitterHex: string
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
  solanaPriorityFeeMicroLamports: number
  sendLookupTable: string
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
    wormholescanBackstopMaxPages: parsed.WORMHOLESCAN_BACKSTOP_MAX_PAGES,
    backstopIntervalMs: parsed.BACKSTOP_INTERVAL_MS,
    refundIntervalMs: parsed.REFUND_INTERVAL_MS,
    maxConcurrentRefunds: parsed.MAX_CONCURRENT_REFUNDS,
    fogoWormholeChainId: parsed.FOGO_WORMHOLE_CHAIN_ID,
    fogoUsdcEmitterHex: parsed.FOGO_USDC_EMITTER_HEX,
    fogoOnycEmitterHex: parsed.FOGO_ONYC_EMITTER_HEX,
    solanaOnycEmitterHex: parsed.SOLANA_ONYC_EMITTER_HEX,
    solanaUsdcEmitterHex: parsed.SOLANA_USDC_EMITTER_HEX,
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
    solanaPriorityFeeMicroLamports: parsed.SOLANA_PRIORITY_FEE_MICROLAMPORTS,
    sendLookupTable: parsed.SEND_LOOKUP_TABLE,
    checkpointPath: parsed.CHECKPOINT_PATH,
    logLevel: parsed.LOG_LEVEL,
  }
}
