import { readFileSync } from 'node:fs'
import { AnchorProvider, Wallet } from '@anchor-lang/core'
import { RelayerClient } from '@fogo-onre/sdk'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import type { AdvanceContext } from './advance/types'
import { loadConfig } from './config'
import { runDaemon } from './daemon'
import { createMetrics } from './metrics'
import { scanAndAdvance } from './scan'

/**
 * Throws if the cranker pubkey equals RelayerConfig.authority.
 *
 * The cranker is grief-only: a stolen cranker host costs at most a few
 * SOL of fee burn. The authority key has fee/redemption-cancel/fee_vault
 * powers — never co-locate. This invariant is enforced here, off-chain,
 * because the program has no way to know which keypair is "the cranker".
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
export function installShutdownHandlers(controller: AbortController): void {
  const onSignal = (sig: string): void => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'info', msg: 'shutdown signal', sig }))
    controller.abort()
  }
  process.once('SIGTERM', () => onSignal('SIGTERM'))
  process.once('SIGINT', () => onSignal('SIGINT'))
}

async function main(): Promise<void> {
  const cfg = loadConfig(process.env)

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
  }
  catch (err) {
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

  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    level: 'info',
    msg: 'cranker started',
    cranker: keypair.publicKey.toBase58(),
    authority: (relayerConfig.authority as PublicKey).toBase58(),
    relayerProgram: client.program.programId.toBase58(),
    metricsPort: metrics.actualPort(),
  }))

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

  const shutdown = new AbortController()
  installShutdownHandlers(shutdown)

  try {
    await runDaemon({
      scan: signal => scanAndAdvance(
        { ...advanceCtxBase, abortSignal: signal },
        {
          maxConcurrentAdvances: cfg.maxConcurrentAdvances,
          rpcTimeoutMs: cfg.rpcTimeoutMs,
        },
      ),
      metrics,
      intervalMs: cfg.scanIntervalMs,
      heartbeatStaleMs: cfg.heartbeatStaleMs,
      abortSignal: shutdown.signal,
    })
  }
  finally {
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
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'fatal', msg: 'unhandledRejection', reason: String(reason) }))
    process.exit(1)
  })
  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'fatal', msg: 'uncaughtException', err: String(err) }))
    process.exit(1)
  })

  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      level: 'fatal',
      msg: 'unhandled error in main',
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }))
    process.exit(1)
  })
}
