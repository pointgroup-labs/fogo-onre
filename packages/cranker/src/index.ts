import type { AdvanceContext } from './advance/types'
import type { Logger } from './log'
import type { Metrics } from './metrics'
import { readFileSync } from 'node:fs'
import { AnchorProvider, Wallet } from '@anchor-lang/core'
import { RelayerClient } from '@fogo-onre/sdk'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { loadConfig } from './config'
import { runDaemon } from './daemon'
import { makeEnumerator } from './enumerate'
import { createLogger } from './log'
import { createMetrics } from './metrics'
import { scanAndAdvance } from './scan'

export * from './vaa'
export * from './wormholescan'

/**
 * Throws if the cranker pubkey equals RelayerConfig.authority.
 *
 * The cranker is grief-only: a stolen cranker host costs at most a few
 * SOL of fee burn. The authority key has fee/redemption-cancel/fee_vault
 * powers — never co-locate. Enforced here, off-chain, because the
 * program has no way to know which keypair is "the cranker".
 */
export function assertCrankerNotAuthority(authority: PublicKey, crankerPubkey: PublicKey): void {
  if (authority.equals(crankerPubkey)) {
    throw new Error(
      'CRANKER_KEYPAIR equals RelayerConfig.authority — refusing to start. '
      + 'The cranker is grief-only; the authority key holds fee + redemption-cancel powers '
      + 'and must never be co-located with the cranker host.',
    )
  }
}

/**
 * Wires SIGTERM/SIGINT to abort the controller. `once` (not `on`) so a
 * second signal escalates to default behavior (immediate kill) rather
 * than being silently swallowed.
 */
export function installShutdownHandlers(controller: AbortController, log?: Logger): void {
  const onSignal = (sig: string): void => {
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
      args.log.warn('balance poll failed', { err: String(err) })
      args.metrics.rpcErrors.inc({ endpoint: 'solana', kind: 'getBalance' })
    }
  }
  // Fire once immediately so the gauge is non-zero before the first scrape.
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
    args.log.warn('ws subscribe failed', { err: String(err) })
    args.metrics.wsAlive.set(0)
    return
  }
  args.signal.addEventListener('abort', () => {
    if (subId !== undefined) {
      args.connection.removeSlotChangeListener(subId).catch(() => undefined)
    }
  }, { once: true })
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

  // Load keypair. Wrap to control error message — the path is fine to
  // log; the secret bytes are not.
  let keypair: Keypair
  try {
    const raw = readFileSync(cfg.keypairPath, 'utf8')
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
  } catch (err) {
    throw new Error(`failed to load keypair from ${cfg.keypairPath}: ${err instanceof Error ? err.message : String(err)}`)
  }

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

  // Invariant gate — must run BEFORE any scan dispatch.
  const relayerConfig = await client.fetchConfig()
  assertCrankerNotAuthority(relayerConfig.authority as PublicKey, keypair.publicKey)

  log.info('cranker started', {
    cranker: keypair.publicKey.toBase58(),
    authority: (relayerConfig.authority as PublicKey).toBase58(),
    relayerProgram: client.program.programId.toBase58(),
    metricsPort: metrics.actualPort(),
    fogoUsdcEmitterConfigured: Boolean(cfg.fogoUsdcEmitterHex),
    fogoOnycEmitterConfigured: Boolean(cfg.fogoOnycEmitterHex),
  })

  const shutdown = new AbortController()
  installShutdownHandlers(shutdown, log)

  // Background pollers — fire-and-forget, bound to shutdown signal.
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
    metrics,
  } satisfies Omit<AdvanceContext, 'abortSignal'>

  // Periodic invariant re-check. Cheap (one fetchConfig per scan) and
  // catches authority rotation that happens while we're running.
  const preScan = async (): Promise<void> => {
    const cfgFresh = await client.fetchConfig()
    assertCrankerNotAuthority(cfgFresh.authority as PublicKey, keypair.publicKey)
  }

  try {
    await runDaemon({
      scan: signal => scanAndAdvance(
        { ...advanceCtxBase, abortSignal: signal },
        {
          maxConcurrentAdvances: cfg.maxConcurrentAdvances,
          rpcTimeoutMs: cfg.rpcTimeoutMs,
          enumerateFlows,
          skipCounter: metrics.flowSkipped,
        },
      ),
      metrics,
      intervalMs: cfg.scanIntervalMs,
      heartbeatStaleMs: cfg.heartbeatStaleMs,
      maxBackoffMs: cfg.scanMaxBackoffMs,
      shutdownDeadlineMs: cfg.shutdownDeadlineMs,
      preScan,
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
    console.error(JSON.stringify({ level: 'fatal', msg: 'unhandledRejection', reason: String(reason) }))
    process.exit(1)
  })
  process.on('uncaughtException', (err) => {
    console.error(JSON.stringify({ level: 'fatal', msg: 'uncaughtException', err: String(err) }))
    process.exit(1)
  })

  main().catch((err) => {
    console.error(JSON.stringify({
      level: 'fatal',
      msg: 'unhandled error in main',
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }))
    process.exit(1)
  })
}
