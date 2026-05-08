import type { AdvanceContext } from './advance/types'
import type { Logger } from './log'
import type { Metrics } from './metrics'
import { readFileSync } from 'node:fs'
import { AnchorProvider, Wallet } from '@anchor-lang/core'
import { RelayerClient } from '@fogo-onre/sdk'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { type BridgeRedeemTarget, buildSolanaOnycToFogoTarget, scanAndRedeemBridge } from './bridge'
import { loadConfig } from './config'
import { runDaemon } from './daemon'
import { makeEnumerator } from './enumerate'
import { createLogger, errorFields, errorMessage, writeLogLine } from './log'
import { createMetrics } from './metrics'
import { scanAndAdvance } from './scan'


type ShutdownSignal = 'SIGTERM' | 'SIGINT'

/**
 * Wires SIGTERM/SIGINT to abort the controller. `once` (not `on`) so a
 * second signal escalates to default behavior (immediate kill) rather
 * than being silently swallowed.
 */
export function installShutdownHandlers(controller: AbortController, log?: Logger): void {
  const onSignal = (sig: ShutdownSignal): void => {
    log?.info('shutdown signal', { sig })
    controller.abort()
  }
  process.once('SIGTERM', () => onSignal('SIGTERM'))
  process.once('SIGINT', () => onSignal('SIGINT'))
}

/**
 * Background SOL-balance poller. Sets `cranker_keypair_sol_balance` so
 * the `CrankerKeypairLowSol` alert is real. Runs until aborted; errors
 * are logged but never thrown — a temporary RPC blip shouldn't kill the
 * daemon.
 */
export function startBalancePoller(args: {
  connection: Connection
  pubkey: PublicKey
  metrics: Metrics
  intervalMs: number
  log: Logger
  signal: AbortSignal
}): void {
  const tick = async (): Promise<void> => {
    try {
      const lamports = await args.connection.getBalance(args.pubkey, 'confirmed')
      args.metrics.solBalance.set(lamports / LAMPORTS_PER_SOL)
    } catch (err) {
      args.log.warn('balance poll failed', errorFields(err))
      args.metrics.rpcErrors.inc({ endpoint: 'solana', kind: 'getBalance' })
    }
  }
  void tick()
  const handle = setInterval(() => {
    if (args.signal.aborted) {
      clearInterval(handle)
      return
    }
    void tick()
  }, args.intervalMs)
  handle.unref()
  args.signal.addEventListener('abort', () => clearInterval(handle), { once: true })
}

/**
 * Best-effort WebSocket-alive flag. `prom-client` Gauge defaults to 0,
 * so we set it to 1 once we can confirm the WS is live (slot subscription
 * landed). On error, set 0. This signals the operator (and Grafana) when
 * the WS is dead and the daemon is falling back to polling.
 */
export function startWsKeepalive(args: {
  connection: Connection
  metrics: Metrics
  log: Logger
  signal: AbortSignal
}): void {
  let subId: number | undefined
  try {
    subId = args.connection.onSlotChange(() => {
      args.metrics.wsAlive.set(1)
    })
  } catch (err) {
    args.log.warn('ws subscribe failed', errorFields(err))
    args.metrics.wsAlive.set(0)
    return
  }
  args.signal.addEventListener('abort', () => {
    if (subId !== undefined) {
      args.connection.removeSlotChangeListener(subId).catch(() => undefined)
    }
  }, { once: true })
}

function loadKeypair(path: string): Keypair {
  try {
    const raw = readFileSync(path, 'utf8')
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
  } catch (err) {
    throw new Error(`failed to load keypair from ${path}: ${errorMessage(err)}`)
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)
  const log = createLogger({ level: cfg.logLevel })

  // Bind metrics + healthz first so Docker's healthcheck has a target
  // during cold-start RPC fetches.
  const metrics = createMetrics({
    port: cfg.metricsPort,
    heartbeatStaleMs: cfg.heartbeatStaleMs,
  })
  await metrics.start()

  const keypair = loadKeypair(cfg.keypairPath)

  const connection = new Connection(cfg.solanaRpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: cfg.solanaWsUrl,
  })
  const fogoConnection = new Connection(cfg.fogoRpcUrl, { commitment: 'confirmed' })

  const wallet = new Wallet(keypair)
  const provider = new AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  })
  const client = new RelayerClient(provider)

  const relayerConfig = await client.fetchConfig()

  log.info('cranker started', {
    cranker: keypair.publicKey.toBase58(),
    authority: (relayerConfig.authority as PublicKey).toBase58(),
    relayerProgram: client.program.programId.toBase58(),
    metricsPort: metrics.actualPort(),
    fogoUsdcEmitterConfigured: Boolean(cfg.fogoUsdcEmitterHex),
    fogoOnycEmitterConfigured: Boolean(cfg.fogoOnycEmitterHex),
    bridgePipelineEnabled: cfg.bridgePipelineEnabled,
    logLevel: cfg.logLevel,
  })

  const shutdown = new AbortController()
  installShutdownHandlers(shutdown, log)

  startBalancePoller({
    connection,
    pubkey: keypair.publicKey,
    metrics,
    intervalMs: cfg.balancePollIntervalMs,
    log,
    signal: shutdown.signal,
  })
  startWsKeepalive({ connection, metrics, log, signal: shutdown.signal })

  const enumerateFlows = makeEnumerator({
    fogoWormholeChainId: cfg.fogoWormholeChainId,
    fogoUsdcEmitterHex: cfg.fogoUsdcEmitterHex,
    fogoOnycEmitterHex: cfg.fogoOnycEmitterHex,
    pageSize: cfg.wormholescanPageSize,
    maxPages: cfg.wormholescanMaxPages,
    baseUrl: cfg.wormholescanUrl,
  })

  const advanceCtxBase = {
    connection,
    fogoConnection,
    provider,
    client,
    keypair,
    relayerProgramId: client.program.programId,
    wormholescanUrl: cfg.wormholescanUrl,
    wormholescanTimeoutMs: cfg.wormholescanTimeoutMs,
    rpcTimeoutMs: cfg.rpcTimeoutMs,
    metrics,
    log,
    // Cross-scan cache: FOGO source-tx → user wallet. claim_usdc resolves
    // user wallets by reading the original FOGO bridge_ntt_tokens source
    // ATA owner; cache so repeat scans don't re-fetch the same tx.
    userWalletCache: new Map<string, PublicKey>(),
  } satisfies Omit<AdvanceContext, 'abortSignal'>

  try {
    // One Map per process — dedupes recurring per-flow advance failures so
    // unrecoverable flows don't spam warn every scan interval.
    const seenAdvanceErrors = new Map<string, string>()
    const seenBridgeErrors = new Map<string, string>()

    // Probe the FOGO ONyc Config once at startup (not per VAA). Mode is
    // a deploy-time invariant — flipping it requires NTT governance — so
    // a fresh decode + assert is sufficient. Failure to probe is fatal:
    // a bridge that picks the wrong release variant will emit a
    // confusing on-chain error every scan, which is worse than not
    // running.
    let bridgeTarget: BridgeRedeemTarget | undefined
    if (cfg.bridgePipelineEnabled) {
      try {
        bridgeTarget = await buildSolanaOnycToFogoTarget({
          fogoConnection,
          destSigner: keypair,
          solanaOnycEmitterHex: cfg.solanaOnycEmitterHex,
          rpcTimeoutMs: cfg.rpcTimeoutMs,
        })
        log.info('bridge target initialized', {
          target: bridgeTarget.name,
          sourceChainId: bridgeTarget.sourceChainId,
          destChainId: bridgeTarget.destChainId,
          destNttManager: bridgeTarget.destNttManagerProgramId.toBase58(),
          destMint: bridgeTarget.destMint.toBase58(),
          destReleaseMode: bridgeTarget.destReleaseMode,
          configReady: bridgeTarget.configReady,
        })
        if (!bridgeTarget.configReady) {
          // Loud warn (not fatal) — the rest of the daemon (including
          // the relayer Flow scanner) should keep running. The bridge
          // pipeline will noop every VAA with a precise reason until
          // governance lands the missing peer / transceiver / rate-limit.
          log.warn('bridge target NOT redeem-ready — VAAs will be skipped until NTT governance lands missing state', {
            target: bridgeTarget.name,
            configError: bridgeTarget.configError,
          })
        }
      } catch (err) {
        log.warn('bridge target init failed — continuing with relayer Flow scanner only', errorFields(err))
      }
    }

    await runDaemon({
      scan: async (signal) => {
        const advanceCtx = { ...advanceCtxBase, abortSignal: signal }
        const flowScan = scanAndAdvance(advanceCtx, {
          maxConcurrentAdvances: cfg.maxConcurrentAdvances,
          rpcTimeoutMs: cfg.rpcTimeoutMs,
          enumerateFlows,
          skipCounter: metrics.flowSkipped,
          seenAdvanceErrors,
        })
        const bridgeScan = bridgeTarget
          ? scanAndRedeemBridge(
              {
                log,
                metrics: {
                  redeemed: metrics.bridgeRedeemed,
                  txSent: metrics.txSent,
                  rpcErrors: metrics.rpcErrors,
                },
                abortSignal: signal,
                wormholescanUrl: cfg.wormholescanUrl,
                wormholescanTimeoutMs: cfg.wormholescanTimeoutMs,
                rpcTimeoutMs: cfg.rpcTimeoutMs,
                txConfirmTimeoutMs: cfg.txConfirmTimeoutMs,
              },
              bridgeTarget,
              {
                pageSize: cfg.wormholescanPageSize,
                maxPages: cfg.wormholescanMaxPages,
                maxConcurrentRedeems: cfg.bridgeMaxConcurrent,
                seenRedeemErrors: seenBridgeErrors,
              },
            )
          : Promise.resolve()
        // allSettled (not Promise.all): a bridge-pipeline failure must
        // not poison the relayer Flow scanner's heartbeat. Each leg's
        // own error handling already maps per-VAA failures to noop +
        // metrics; a rejection here means the *scan itself* threw —
        // surface it but don't let the other leg drag the daemon down.
        const results = await Promise.allSettled([flowScan, bridgeScan])
        const labels = ['flow', 'bridge'] as const
        for (let i = 0; i < results.length; i++) {
          const r = results[i]
          if (r.status === 'rejected') {
            metrics.bridgeScanIterations.inc({
              target: labels[i] === 'bridge' ? (bridgeTarget?.name ?? 'bridge') : 'flow',
              result: 'error',
            })
            // Re-throw so runDaemon's backoff logic sees the failure —
            // but only if BOTH failed; a single-leg failure shouldn't
            // trip backoff if the other leg is healthy.
            if (results.every(x => x.status === 'rejected')) {
              throw r.reason instanceof Error ? r.reason : new Error(String(r.reason))
            }
            log.warn(`${labels[i]} scan leg failed (other leg ok)`, errorFields(r.reason))
          } else if (labels[i] === 'bridge' && bridgeTarget) {
            metrics.bridgeScanIterations.inc({ target: bridgeTarget.name, result: 'ok' })
          }
        }
      },
      metrics,
      intervalMs: cfg.scanIntervalMs,
      heartbeatStaleMs: cfg.heartbeatStaleMs,
      maxBackoffMs: cfg.scanMaxBackoffMs,
      shutdownDeadlineMs: cfg.shutdownDeadlineMs,
      abortSignal: shutdown.signal,
    })
  } finally {
    await metrics.stop().catch(() => undefined)
  }
}

/**
 * Run the cranker. Wires top-level handlers and invokes `main()`.
 * Exported so tests can import this module without auto-starting.
 * The CLI bootstrapper at `bin.ts` is the only caller.
 */
export function bootstrap(): void {
  process.on('unhandledRejection', (reason) => {
    writeLogLine('fatal', 'unhandledRejection', errorFields(reason))
    process.exit(1)
  })
  process.on('uncaughtException', (err) => {
    writeLogLine('fatal', 'uncaughtException', errorFields(err))
    process.exit(1)
  })

  main().catch((err) => {
    writeLogLine('fatal', 'unhandled error in main', errorFields(err))
    process.exit(1)
  })
}
