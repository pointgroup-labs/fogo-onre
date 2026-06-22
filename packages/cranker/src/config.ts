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

/**
 * Cranker runtime config schema. THIS IS THE SINGLE SOURCE OF TRUTH.
 *
 * `deploy/cranker/cranker.env.example` is generated from this schema by
 * `tests/cranker-env-sync.test.ts` (run `make gen-env` to regenerate).
 * Each field's `.describe()` text becomes the operator-facing comment in the
 * generated example, so doc drift fails CI by construction.
 *
 * Conventions:
 * - `.describe()` is operator-facing prose. Keep it to 1–3 lines, explain
 *   why* the default is what it is, and call out boot-breaking failure
 *   modes (RPC rejection, tx-overflow, silent fund stranding).
 * - Defaults are safe for mainnet steady-state; operators should only need
 *   to override under incident or fork conditions.
 * - The generator groups fields by position here, top-to-bottom, so keep
 *   required fields first — the example reads as a setup checklist.
 */
export const configSchema = z.object({
  SOLANA_RPC_URL: z.string().url().refine(
    u => !u.includes('api.mainnet-beta.solana.com'),
    { message: 'public mainnet-beta RPC disabled getProgramAccounts; use a paid RPC (Helius/QuickNode/Triton)' },
  ).describe('Paid Solana mainnet RPC. PUBLIC mainnet-beta is REJECTED at boot because it disables getProgramAccounts which the scanner requires. Helius / QuickNode / Triton are known-good.'),
  SOLANA_WS_URL: z.string().url().describe('Solana WebSocket endpoint for live VAA delivery. Same provider as SOLANA_RPC_URL; a dead socket falls back to the (slower) Wormholescan poll and trips CrankerWebSocketDead.'),
  FOGO_RPC_URL: z.string().url().describe('FOGO RPC. The same cranker keypair pays bridge-redeem fees on FOGO; if this is unreachable, Solana → FOGO ONyc redeems stall and the FOGO balance poll goes stale.'),
  KEYPAIR_PATH: z.string().min(1).describe('Cranker signing keypair (Solana JSON-array secret-key format). Under the bundled docker-compose this MUST be /secrets/cranker-keypair.json — the host file ./secrets/cranker-keypair.json is mounted read-only at that path. MUST NOT equal PairConfig.authority: the cranker is grief-only, and co-locating with the authority gives a stolen host fee + redemption-cancel powers. Boot aborts if the invariant is violated.'),

  WORMHOLESCAN_URL: z.string().url().default('https://api.wormholescan.io').describe('Wormholescan API base. The public hosted endpoint is fine for production; override only if you run a private instance.'),
  WORMHOLESCAN_PAGE_SIZE: z.coerce.number().int().min(1).max(200).default(50).describe('Pagination size for the VAA-listing call. Higher = fewer round-trips, lower = smaller per-call response.'),
  WORMHOLESCAN_MAX_PAGES: z.coerce.number().int().min(1).max(20).default(2).describe('Max pages per incremental scan. Raise temporarily after a long outage to backfill the queue; steady-state needs only 1–2.'),
  WORMHOLESCAN_BACKSTOP_MAX_PAGES: z.coerce.number().int().min(1).max(200).default(50).describe('Backstop scan depth: a periodic enumeration that ignores the watermark, catching flows the incremental scan stranded — VAAs that arrived during downtime (watermark fast-forwarded past them) or orphan Flow PDAs from a failed post-watermark dispatch. 50×50 ≈ several days of mainnet volume.'),
  BACKSTOP_INTERVAL_MS: z.coerce.number().int().min(0).default(300_000).describe('Period between backstop sweeps. 0 disables. Default 5 minutes.'),

  REFUND_INTERVAL_MS: z.coerce.number().int().min(0).default(0).describe('Period between refund sweeps: NTT-sends the original token back for Received flows past REFUND_TIMEOUT_SLOTS. 0 disables (default: opt in until the NTT send-back manager wiring is verified). Suggested ~15min once enabled.'),
  MAX_CONCURRENT_REFUNDS: z.coerce.number().int().min(1).max(32).default(2).describe('Refund-side concurrency budget — separate so refunds cannot starve normal advances.'),

  FOGO_WORMHOLE_CHAIN_ID: z.coerce.number().int().min(1).default(FOGO_WORMHOLE_CHAIN_ID).describe('FOGO Wormhole chain ID (source chain for VAA polling). Defaults to the SDK constant (51 = FOGO mainnet). Override only when pointing at a different source chain.'),
  FOGO_USDC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_USDC_EMITTER_HEX).describe('32-byte hex (no 0x prefix) emitter of the FOGO USDC.s NTT manager. Defaults to the ["emitter"] PDA derived from the SDK NTT_USDC_PROGRAM_ID. Override only when pointing at a redeployed manager.'),
  FOGO_ONYC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_ONYC_EMITTER_HEX).describe('32-byte hex emitter of the FOGO ONyc NTT manager. Defaults to the SDK PDA; override for a redeployed manager.'),
  SOLANA_ONYC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_SOLANA_ONYC_EMITTER_HEX).describe('32-byte hex emitter of the Solana ONyc NTT manager — outbound bridge source. Same bytecode on both chains, so defaults to the same SDK PDA.'),
  SOLANA_USDC_EMITTER_HEX: z.string().regex(/^[0-9a-f]{64}$/i).default(DEFAULT_SOLANA_USDC_EMITTER_HEX).describe('32-byte hex emitter of the Solana USDC.s NTT manager — source for the redeem-completion leg. Defaults to the SDK NTT_USDC_PROGRAM_ID PDA.'),
  BRIDGE_PIPELINE_ENABLED: z.enum(['true', 'false']).default('true').describe('Set to "false" to disable the Solana → FOGO ONyc bridge pipeline (e.g. during incident triage). Flow advances continue independently.'),
  BRIDGE_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(4).describe('Bridge-side concurrency budget — separate from MAX_CONCURRENT_ADVANCES so a Wormholescan backfill cannot starve normal Flow advances.'),

  METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9090).describe('Network port for /metrics and /healthz. Bound 0.0.0.0 inside the container; compose binds 127.0.0.1 on the host so Tailscale-only operators see it but the public internet does not.'),

  SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000).describe('Base interval between scan iterations (success path). Backoff multiplies this on consecutive errors up to SCAN_MAX_BACKOFF_MS.'),
  SCAN_MAX_BACKOFF_MS: z.coerce.number().int().min(1000).default(300_000).describe('Cap on exponential backoff after consecutive scan errors. Backoff is SCAN_INTERVAL_MS * 2^errors, clamped here. 5 minutes is a sane default for a flapping RPC.'),
  SHUTDOWN_DEADLINE_MS: z.coerce.number().int().min(1000).default(8000).describe('How long the daemon waits for an in-flight scan to drain on SIGTERM before abandoning it. Must be < Docker stop_grace_period (30s) so we do not lose to SIGKILL mid-cleanup.'),
  BALANCE_POLL_INTERVAL_MS: z.coerce.number().int().min(5000).default(60_000).describe('How often to poll the cranker SOL/FOGO balance (powers the LowSol / LowFogo / BalancePollStale alerts).'),

  RPC_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000).describe('Per-RPC-call timeout. Caps any single getProgramAccounts / getMultipleAccounts so a stuck RPC cannot pin a worker forever.'),
  ENUMERATE_TIMEOUT_MS: z.coerce.number().int().min(5000).default(90_000).describe('Budget for one enumerateFlows call. Separate from RPC_TIMEOUT_MS because a fresh checkpoint-less process backfills the full page window (50–100 round-trips) and 15s is not enough.'),
  TX_CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(30_000).default(90_000).describe('Per-transaction confirmation budget. The 30s floor is sized for the core.postVaa multi-tx sequence (several verify_signatures + one post_vaa); anything lower aborts mid-sequence and silently bricks withdraw flows under congestion.'),
  WORMHOLESCAN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000).describe('Per-Wormholescan-call timeout.'),
  HEARTBEAT_STALE_MS: z.coerce.number().int().min(30_000).default(120_000).describe('Heartbeat-staleness threshold for the self-kill watchdog. If the scan loop fails to stamp the heartbeat for this long, the daemon process.exit(1)s so Docker restart policy lifts it. Must be >> SCAN_INTERVAL_MS + worst-case scan duration; 2 min is comfortable.'),
  MAX_CONCURRENT_ADVANCES: z.coerce.number().int().min(1).max(32).default(4).describe('Max simultaneous advance dispatches. Each advance is one CPI tx; higher numbers reduce per-flow latency but raise SOL burn rate during bursts. Stay << RPC provider per-second cap.'),

  SOLANA_PRIORITY_FEE_MICROLAMPORTS: z.coerce.number().int().min(0).default(10_000).describe('Priority fee (µ-lamports/CU) prepended to every Solana tx. Without a non-zero value mainnet leaders deprioritize the tx and the blockhash expires before inclusion. Default 10_000 clears a moderately congested mainnet; bump to 50_000+ during incidents (takes effect next scan).'),
  SEND_LOOKUP_TABLE: z.string().min(32).default('9aF7QN6HTtfQ6Wvo2UMFeTuHyaBxidMHhbTbN16Bwuyk').describe('Address Lookup Table compressing the send leg stable NTT/Wormhole accounts — required for the outbound tx to fit the 1232-byte limit (else the v0 message inlines every account and overflows). Defaults to the live mainnet send-leg LUT so a forgotten env var cannot brick sends. Override for devnet/testnet.'),

  CHECKPOINT_PATH: z.string().default('./cranker-checkpoint.json').describe('On-disk checkpoint file (per-emitter watermarks). Empty string disables persistence (in-memory watermarks still apply per process). On-chain idempotency makes a lost checkpoint a one-time backfill, never a missed dispatch.'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info').describe('debug | info | warn | error. JSON-per-line on stderr.'),
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
  const parsed = configSchema.parse(env)
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
