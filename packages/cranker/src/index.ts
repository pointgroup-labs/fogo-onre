import type { RecoveredWalletAndMinOut } from '@fogo-yield/sdk'
import type { BridgeRedeemTarget } from './bridge'
import type { CrankerConfig } from './config'
import type { Metrics } from './metrics'
import type { AdvanceContext, EnumerateFlowsFn } from './relayer'
import type { WatermarkStore } from './state'
import type { Logger } from './utils/log'
import { readFileSync } from 'node:fs'
import { AnchorProvider, Wallet } from '@anchor-lang/core'
import { ONYC_MINT, RelayerClient, USDC_MINT } from '@fogo-yield/sdk'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { buildSolanaOnycToFogoTarget, buildSolanaUsdcToFogoTarget, scanAndRedeemBridge } from './bridge'
import { loadConfig } from './config'
import { runDaemon } from './daemon'
import { createMetrics } from './metrics'
import { makeEnumerator, scanAndAdvance, scanAndRefund } from './relayer'
import { FlowStateTracker, loadCheckpoint, saveCheckpoint, watermarksFromCheckpoint } from './state'
import { BoundedMap } from './utils/bounded-map'
import { createLogger, errorFields, errorMessage, writeLogLine } from './utils/log'
import { WakeFlag } from './utils/wake-flag'

// Per-process bound for the FOGO-tx → user-wallet cache. ~10k entries ×
// ~80 bytes ≈ <1 MB RSS. Authoritative source is the chain; eviction at
// most causes one extra FOGO RPC the next time the same VAA enumerates.
const USER_WALLET_CACHE_MAX = 10_000

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
 * Background balance poller for the cranker keypair's gas (one per chain;
 * it pays on both Solana and FOGO). On RPC failure the gauge is set to NaN,
 * not left stale — else an outage masks a draining balance and the alert never
 * fires; the companion age gauge keeps growing so "RPC down" stays
 * distinguishable from "poller dead". Errors logged, never thrown.
 */
export function startBalancePoller(args: {
  chain: 'solana' | 'fogo'
  connection: Connection
  pubkey: PublicKey
  metrics: Metrics
  intervalMs: number
  log: Logger
  signal: AbortSignal
}): void {
  const balanceGauge = args.chain === 'solana' ? args.metrics.solBalance : args.metrics.fogoBalance
  const tick = async (): Promise<void> => {
    try {
      const lamports = await args.connection.getBalance(args.pubkey, 'confirmed')
      balanceGauge.set(lamports / LAMPORTS_PER_SOL)
      args.metrics.recordBalancePollSuccess(args.chain)
    } catch (err) {
      args.log.warn('balance poll failed', { chain: args.chain, ...errorFields(err) })
      balanceGauge.set(Number.NaN)
      args.metrics.rpcErrors.inc({ endpoint: args.chain, kind: 'getBalance' })
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
 * Best-effort WebSocket-alive flag: set to 1 while a slot subscription is
 * delivering, 0 when dead. Re-arms the subscription on a fixed interval so a
 * dropped socket recovers instead of latching the gauge at 0 forever.
 * Signals the operator when the WS is dead and the daemon is falling back to
 * polling.
 */
export function startWsKeepalive(args: {
  connection: Connection
  metrics: Metrics
  log: Logger
  signal: AbortSignal
  resubscribeIntervalMs?: number
}): void {
  const resubscribeIntervalMs = args.resubscribeIntervalMs ?? 30_000
  let subId: number | undefined
  let lastTickAt = 0

  const removeListener = (): void => {
    if (subId !== undefined) {
      const id = subId
      subId = undefined
      args.connection.removeSlotChangeListener(id).catch(() => undefined)
    }
  }
  const subscribe = (): void => {
    try {
      subId = args.connection.onSlotChange(() => {
        lastTickAt = Date.now()
        args.metrics.wsAlive.set(1)
      })
    } catch (err) {
      args.log.warn('ws subscribe failed', errorFields(err))
      args.metrics.wsAlive.set(0)
    }
  }
  subscribe()

  // No slot ticks within the interval ⇒ socket is dead: drop the gauge and
  // re-subscribe (the prior listener never recovers on its own).
  const handle = setInterval(() => {
    if (args.signal.aborted) {
      clearInterval(handle)
      return
    }
    if (subId === undefined || (lastTickAt !== 0 && Date.now() - lastTickAt > resubscribeIntervalMs)) {
      args.metrics.wsAlive.set(0)
      removeListener()
      subscribe()
    }
  }, resubscribeIntervalMs)
  handle.unref()

  args.signal.addEventListener('abort', () => {
    clearInterval(handle)
    removeListener()
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

type ScanDeps = {
  advanceCtxBase: Omit<AdvanceContext, 'abortSignal'>
  bridgeTargets: BridgeRedeemTarget[]
  cfg: CrankerConfig
  metrics: Metrics
  log: Logger
  enumerateFlows: EnumerateFlowsFn
  /** When set, this tick also runs a refund sweep over `Received` flows past timeout. */
  refundEnumerateFlows?: EnumerateFlowsFn
  seenAdvanceErrors: Map<string, string>
  seenBridgeErrors: Map<string, string>
  seenRefundErrors: Map<string, string>
  flowState: FlowStateTracker
  /** Per-emitter Wormholescan watermarks, shared with `makeEnumerator`. */
  watermarks: WatermarkStore
  /** Fired by either leg on progress so the daemon wakes early. */
  wakeup: WakeFlag
}

/**
 * One scan iteration: dispatches the relayer-Flow scanner and (if
 * configured) the bridge scanner concurrently, isolates their failures
 * so a sick leg doesn't poison the heartbeat of the healthy leg, and
 * re-throws to `runDaemon` only when *both* legs failed.
 *
 * `Promise.allSettled` (not `Promise.all`): per-VAA failures are already
 * mapped to noop + metrics inside each leg; a rejection here means the
 * scan itself threw — surface it but don't drag the other leg down.
 */
async function runScanIteration(deps: ScanDeps, signal: AbortSignal): Promise<void> {
  const { advanceCtxBase, bridgeTargets, cfg, metrics, log, enumerateFlows, refundEnumerateFlows, seenAdvanceErrors, seenBridgeErrors, seenRefundErrors, flowState, watermarks, wakeup } = deps
  const advanceCtx = { ...advanceCtxBase, abortSignal: signal }
  // Coalesce the wake signal: a tick that advances 12 flows shouldn't
  // signal 12 separate wakes. The scan*-side `progress` boolean does the
  // batching; this just relays. WakeFlag deduplicates by design — multiple
  // signal()s between two wait()s coalesce.
  const onProgress = (): void => {
    wakeup.signal()
  }

  const flowScan = scanAndAdvance(advanceCtx, {
    maxConcurrentAdvances: cfg.maxConcurrentAdvances,
    rpcTimeoutMs: cfg.rpcTimeoutMs,
    enumerateTimeoutMs: cfg.enumerateTimeoutMs,
    enumerateFlows,
    skipCounter: metrics.flowSkipped,
    seenAdvanceErrors,
    flowState,
    onProgress,
  })
  // One scan invocation per registered bridge target. Each runs against
  // its own source emitter + dest manager, so they're independent — a
  // Wormholescan blip on the ONyc emitter must not stall the USDC.s
  // redeem leg and vice versa. `Promise.allSettled` below isolates a
  // sick target without dragging the healthy ones (or the relayer flow
  // scanner) down.
  const bridgeScans = bridgeTargets.map(target =>
    scanAndRedeemBridge(
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
        priorityFeeMicroLamports: cfg.solanaPriorityFeeMicroLamports,
      },
      target,
      {
        pageSize: cfg.wormholescanPageSize,
        maxPages: cfg.wormholescanMaxPages,
        maxConcurrentRedeems: cfg.bridgeMaxConcurrent,
        seenRedeemErrors: seenBridgeErrors,
        watermarks,
        onProgress,
      },
    ),
  )

  // Refund is the exception path; isolate it like the bridge legs so a
  // refund failure (or a missing NTT send-back wiring) never trips the
  // daemon backoff for the healthy swap/send + bridge legs. Off by default
  // (REFUND_INTERVAL_MS=0); only the refund tick passes an enumerator.
  const refundScan = refundEnumerateFlows
    ? scanAndRefund({ ...advanceCtxBase, abortSignal: signal }, {
        maxConcurrentRefunds: cfg.maxConcurrentRefunds,
        rpcTimeoutMs: cfg.rpcTimeoutMs,
        enumerateTimeoutMs: cfg.enumerateTimeoutMs,
        enumerateFlows: refundEnumerateFlows,
        seenRefundErrors,
      })
    : Promise.resolve()

  const settled = await Promise.allSettled([flowScan, refundScan, ...bridgeScans])
  const flowResult = settled[0]
  const refundResult = settled[1]
  const bridgeResults = settled.slice(2)

  if (flowResult.status === 'rejected') {
    metrics.bridgeScanIterations.inc({ target: 'flow', result: 'error' })
  }
  if (refundResult.status === 'rejected') {
    metrics.bridgeScanIterations.inc({ target: 'refund', result: 'error' })
    log.warn('refund scan leg failed', errorFields(refundResult.reason))
  }
  bridgeResults.forEach((br, i) => {
    const targetName = bridgeTargets[i]?.name ?? 'bridge'
    if (br.status === 'rejected') {
      metrics.bridgeScanIterations.inc({ target: targetName, result: 'error' })
      log.warn('bridge scan leg failed', { target: targetName, ...errorFields(br.reason) })
    } else {
      metrics.bridgeScanIterations.inc({ target: targetName, result: 'ok' })
    }
  })

  // Re-throw only if EVERY leg (flow + all bridges) failed: a single
  // sick leg shouldn't trip the daemon backoff while the rest are
  // healthy. Mirrors the prior single-bridge behavior — a "total
  // outage" signal, not a "any failure" signal. The refund leg is
  // best-effort and excluded from the total-outage signal.
  const allFailed = flowResult.status === 'rejected'
    && bridgeResults.every(br => br.status === 'rejected')
  if (allFailed) {
    throw flowResult.reason instanceof Error
      ? flowResult.reason
      : new Error(String(flowResult.reason))
  }
  if (flowResult.status === 'rejected') {
    log.warn('flow scan leg failed (bridges ok)', errorFields(flowResult.reason))
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
  const client = new RelayerClient(provider, { baseMint: USDC_MINT, assetMint: ONYC_MINT })

  const pairConfig = await client.fetchConfig()

  log.info('cranker started', {
    cranker: keypair.publicKey.toBase58(),
    authority: (pairConfig.authority as PublicKey).toBase58(),
    relayerProgram: client.program.programId.toBase58(),
    metricsPort: metrics.actualPort(),
    fogoUsdcEmitterConfigured: Boolean(cfg.fogoUsdcEmitterHex),
    fogoOnycEmitterConfigured: Boolean(cfg.fogoOnycEmitterHex),
    solanaOnycEmitterConfigured: Boolean(cfg.solanaOnycEmitterHex),
    solanaUsdcEmitterConfigured: Boolean(cfg.solanaUsdcEmitterHex),
    bridgePipelineEnabled: cfg.bridgePipelineEnabled,
    logLevel: cfg.logLevel,
  })

  const shutdown = new AbortController()
  installShutdownHandlers(shutdown, log)

  // Solana side pays for relayer-Flow advances; FOGO side pays for
  // bridge-redeem `transfer_*` submits. Same keypair; different chains.
  startBalancePoller({
    chain: 'solana',
    connection,
    pubkey: keypair.publicKey,
    metrics,
    intervalMs: cfg.balancePollIntervalMs,
    log,
    signal: shutdown.signal,
  })
  startBalancePoller({
    chain: 'fogo',
    connection: fogoConnection,
    pubkey: keypair.publicKey,
    metrics,
    intervalMs: cfg.balancePollIntervalMs,
    log,
    signal: shutdown.signal,
  })
  startWsKeepalive({ connection, metrics, log, signal: shutdown.signal })

  // Persisted across restarts: per-emitter Wormholescan watermarks. A
  // missing/corrupt file is harmless (full backfill, idempotent). Same
  // store is shared between the Flow enumerator and the bridge scanner
  // — keys are emitter-hex so collisions are impossible across legs.
  const checkpoint = cfg.checkpointPath ? loadCheckpoint(cfg.checkpointPath) : undefined
  const watermarks = watermarksFromCheckpoint(checkpoint)
  if (checkpoint) {
    log.info('checkpoint loaded', {
      path: cfg.checkpointPath,
      emitters: Object.keys(checkpoint.watermarks).length,
      updatedAt: checkpoint.updatedAt,
    })
  }

  const enumerateFlows = makeEnumerator({
    fogoWormholeChainId: cfg.fogoWormholeChainId,
    fogoUsdcEmitterHex: cfg.fogoUsdcEmitterHex,
    fogoOnycEmitterHex: cfg.fogoOnycEmitterHex,
    pageSize: cfg.wormholescanPageSize,
    maxPages: cfg.wormholescanMaxPages,
    baseUrl: cfg.wormholescanUrl,
    watermarks,
  })

  // Backstop enumerator — bypasses the watermark and pages much deeper
  // (~days, not ~minutes). Runs on a separate cadence (`backstopIntervalMs`)
  // to recover stranded flows: VAAs that arrived during daemon downtime
  // and whose watermark fast-forwarded past them on resume, OR
  // post-watermark dispatches that failed and left an orphan Flow the
  // incremental scan no longer pages. Set BACKSTOP_INTERVAL_MS=0 to
  // disable.
  const backstopEnumerateFlows = cfg.backstopIntervalMs > 0
    ? makeEnumerator({
        fogoWormholeChainId: cfg.fogoWormholeChainId,
        fogoUsdcEmitterHex: cfg.fogoUsdcEmitterHex,
        fogoOnycEmitterHex: cfg.fogoOnycEmitterHex,
        pageSize: cfg.wormholescanPageSize,
        maxPages: cfg.wormholescanBackstopMaxPages,
        baseUrl: cfg.wormholescanUrl,
        watermarks,
        bypassWatermark: true,
      })
    : undefined

  // Refund enumerator — bypasses the watermark and pages deep (like backstop)
  // because a `Received` flow may sit waiting for its REFUND_TIMEOUT before it
  // becomes refundable, long after the incremental watermark passed it. Built
  // only when refund sweeps are enabled (REFUND_INTERVAL_MS > 0).
  const refundEnumerateFlows = cfg.refundIntervalMs > 0
    ? makeEnumerator({
        fogoWormholeChainId: cfg.fogoWormholeChainId,
        fogoUsdcEmitterHex: cfg.fogoUsdcEmitterHex,
        fogoOnycEmitterHex: cfg.fogoOnycEmitterHex,
        pageSize: cfg.wormholescanPageSize,
        maxPages: cfg.wormholescanBackstopMaxPages,
        baseUrl: cfg.wormholescanUrl,
        watermarks,
        bypassWatermark: true,
      })
    : undefined

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
    txConfirmTimeoutMs: cfg.txConfirmTimeoutMs,
    priorityFeeMicroLamports: cfg.solanaPriorityFeeMicroLamports,
    sendLookupTable: cfg.sendLookupTable ? new PublicKey(cfg.sendLookupTable) : undefined,
    metrics,
    log,
    // Cross-scan cache: FOGO source-tx → recovered { userWallet, minSwapOut }.
    // `receive` recovers the wallet from the bridge_ntt_tokens source-ATA
    // owner and the floor from the tx memo; cache so repeat scans don't
    // re-fetch the same tx.
    userWalletCache: new BoundedMap<string, RecoveredWalletAndMinOut>(USER_WALLET_CACHE_MAX),
  } satisfies Omit<AdvanceContext, 'abortSignal'>

  try {
    // One Map per process — dedupes recurring per-flow advance failures so
    // unrecoverable flows don't spam warn every scan interval.
    const seenAdvanceErrors = new Map<string, string>()
    const seenBridgeErrors = new Map<string, string>()
    const seenRefundErrors = new Map<string, string>()

    // Per-flow ephemeral processing FSM (idle / inFlight / cooldown /
    // poisoned). Gates dispatch to skip flows already in flight or
    // backing off after errors. On-chain Flow PDA remains the truth.
    const flowState = new FlowStateTracker()
    metrics.setStuckFlowProvider(() => flowState.stuckCounts())

    // WakeFlag wakes the daemon early when either leg makes progress —
    // chain busy ⇒ next tick runs sooner than the 30s floor. Sticky-flag
    // semantics mean a signal() during the scan is preserved until the
    // daemon's next wait() consumes it (the EventEmitter version dropped
    // signals fired before the listener attached, silently breaking the
    // wake-on-progress optimization).
    const wakeup = new WakeFlag()

    // Periodic checkpoint flush. The watermark store mutates inside
    // both legs; flushing every 30s bounds the "data we'd lose on a
    // crash" to ~30s of paging redundancy — far cheaper than per-tick
    // I/O and harmless given on-chain idempotency.
    let checkpointTimer: NodeJS.Timeout | undefined
    if (cfg.checkpointPath) {
      checkpointTimer = setInterval(() => {
        try {
          saveCheckpoint(cfg.checkpointPath, watermarks)
        } catch (err) {
          log.warn('checkpoint flush failed', errorFields(err))
        }
      }, 30_000)
      checkpointTimer.unref()
    }

    // Build every bridge target this cranker should drive. Each target
    // is independent (own source emitter, own dest manager) and is
    // dispatched in parallel inside `runScanIteration`. A failure to
    // build *one* target is loud-but-non-fatal — we keep the rest of
    // the daemon (flow scanner + any healthy targets) running so a
    // misconfigured leg can't block deposits or redeems on the healthy
    // legs.
    //
    // Targets:
    //   - `solana-onyc-to-fogo`: inbound (deposit completion). Delivers
    //     ONyc to the user on FOGO after a deposit lands on Solana.
    //   - `solana-usdc-to-fogo`: outbound (redeem completion). Delivers
    //     USDC.s back to the user on FOGO after `send_usdc_to_user`
    //     emits the outbound VAA. Without this leg, redeems strand
    //     at the guardian network and the user never sees their USDC.s.
    const bridgeTargets: BridgeRedeemTarget[] = []
    if (cfg.bridgePipelineEnabled) {
      const builders: { label: string, build: () => Promise<BridgeRedeemTarget> }[] = [
        {
          label: 'solana-onyc-to-fogo',
          build: () => buildSolanaOnycToFogoTarget({
            fogoConnection,
            destSigner: keypair,
            solanaOnycEmitterHex: cfg.solanaOnycEmitterHex,
            rpcTimeoutMs: cfg.rpcTimeoutMs,
          }),
        },
        {
          label: 'solana-usdc-to-fogo',
          build: () => buildSolanaUsdcToFogoTarget({
            fogoConnection,
            destSigner: keypair,
            solanaUsdcEmitterHex: cfg.solanaUsdcEmitterHex,
            rpcTimeoutMs: cfg.rpcTimeoutMs,
          }),
        },
      ]
      for (const { label, build } of builders) {
        try {
          const target = await build()
          bridgeTargets.push(target)
          log.info('bridge target initialized', {
            target: target.name,
            sourceChainId: target.sourceChainId,
            destChainId: target.destChainId,
            destNttManager: target.destNttManagerProgramId.toBase58(),
            destMint: target.destMint.toBase58(),
            destReleaseMode: target.destReleaseMode,
            configReady: target.configReady,
          })
          if (!target.configReady) {
            log.warn('bridge target NOT redeem-ready — VAAs will be skipped until NTT governance lands missing state', {
              target: target.name,
              configError: target.configError,
            })
          }
        } catch (err) {
          log.warn('bridge target init failed — skipping this target, other legs continue', {
            target: label,
            ...errorFields(err),
          })
        }
      }
    }

    // Wall-clock checkpoint for the backstop tick selector below.
    // `lastBackstopAt = 0` means "backstop is due on the first tick";
    // operators see a backstop sweep at startup, which is exactly when
    // post-restart stranding is most likely.
    let lastBackstopAt = 0
    // Edge-triggered against wall-clock (not tick count) so a wakeup burst of
    // fast ticks doesn't fire a refund sweep every tick.
    let lastRefundAt = 0

    await runDaemon({
      scan: (signal) => {
        // Tick selection: a backstop sweep takes the place of the
        // incremental enumeration on ticks where enough wall-clock
        // time has elapsed since the last backstop. The decision is
        // edge-triggered against `now()` (not tick count) so a
        // wakeup-driven burst of fast ticks doesn't fire backstop
        // every tick. Backstop replaces (does not augment) the
        // incremental scan that tick — both would just produce the
        // same VAAs, and the dedupe is harmless but wasteful.
        const now = Date.now()
        let enumerator = enumerateFlows
        if (backstopEnumerateFlows && now - lastBackstopAt >= cfg.backstopIntervalMs) {
          lastBackstopAt = now
          log.info('backstop scan tick', {
            intervalMs: cfg.backstopIntervalMs,
            maxPages: cfg.wormholescanBackstopMaxPages,
          })
          enumerator = backstopEnumerateFlows
        }
        // Refund sweep runs on its own (slow) cadence, alongside (not instead
        // of) the swap/send scan that tick — they drive different flows.
        let refundEnum: EnumerateFlowsFn | undefined
        if (refundEnumerateFlows && now - lastRefundAt >= cfg.refundIntervalMs) {
          lastRefundAt = now
          log.info('refund scan tick', { intervalMs: cfg.refundIntervalMs })
          refundEnum = refundEnumerateFlows
        }
        return runScanIteration({
          advanceCtxBase,
          bridgeTargets,
          cfg,
          metrics,
          log,
          enumerateFlows: enumerator,
          refundEnumerateFlows: refundEnum,
          seenAdvanceErrors,
          seenBridgeErrors,
          seenRefundErrors,
          flowState,
          watermarks,
          wakeup,
        }, signal)
      },
      metrics,
      intervalMs: cfg.scanIntervalMs,
      heartbeatStaleMs: cfg.heartbeatStaleMs,
      maxBackoffMs: cfg.scanMaxBackoffMs,
      shutdownDeadlineMs: cfg.shutdownDeadlineMs,
      abortSignal: shutdown.signal,
      wakeup,
    })
  } finally {
    if (cfg.checkpointPath) {
      // Final flush — captures whatever the last 30s of progress
      // produced before SIGTERM. Best-effort; never block shutdown.
      try {
        saveCheckpoint(cfg.checkpointPath, watermarks)
      } catch (err) {
        log.warn('checkpoint final flush failed', errorFields(err))
      }
    }
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
