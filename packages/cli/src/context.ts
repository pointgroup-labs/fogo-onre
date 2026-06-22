import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AnchorProvider, Wallet } from '@anchor-lang/core'
import { ONYC_MINT, RelayerClient, USDC_MINT } from '@fogo-onre/sdk'
import {
  Cluster,
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
} from '@solana/web3.js'

export interface Context {
  connection: Connection
  keypair: Keypair
  provider: AnchorProvider
  client: RelayerClient
}

let ctx: Context

export function useContext(): Context {
  if (!ctx) {
    throw new Error('CLI context not initialized')
  }
  return ctx
}

const VALID_CLUSTERS = new Set<string>(['mainnet-beta', 'testnet', 'devnet'])

const PROGRAM_ERROR_RE = /custom program error: 0x([0-9a-f]+)/i

export function initContext(opts: {
  url?: string
  keypair?: string
  readOnly?: boolean
  baseMint?: string
  assetMint?: string
}): Context {
  const connection = new Connection(resolveRpcUrl(opts.url), 'confirmed')
  const keypair = opts.readOnly ? Keypair.generate() : resolveKeypair(opts.keypair)
  const wallet = new Wallet(keypair)
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' })
  const baseMint = opts.baseMint ? new PublicKey(opts.baseMint) : USDC_MINT
  const assetMint = opts.assetMint ? new PublicKey(opts.assetMint) : ONYC_MINT
  const client = new RelayerClient(provider, { baseMint, assetMint })
  ctx = { connection, keypair, provider, client }
  return ctx
}

/**
 * Wraps an `async () => Promise<string>` (typically `client.foo({...}).rpc()`),
 * surfaces program-error codes in hex, and rethrows a clean Error.
 */
export async function runTx(send: () => Promise<string>): Promise<string> {
  try {
    return await send()
  } catch (err) {
    throw formatTxError(err)
  }
}

function resolveRpcUrl(url?: string): string {
  if (!url) {
    return clusterApiUrl('mainnet-beta')
  }
  if (url.startsWith('http')) {
    return url
  }
  if (!VALID_CLUSTERS.has(url)) {
    throw new Error(
      `Unknown cluster "${url}". Use: mainnet-beta, testnet, devnet, or an HTTP(S) URL`,
    )
  }
  return clusterApiUrl(url as Cluster)
}

function resolveKeypair(path?: string): Keypair {
  const file = path
    ?? process.env.SOLANA_KEYPAIR
    ?? join(homedir(), '.config', 'solana', 'id.json')

  const raw = readFileSync(file, 'utf-8')
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
}

function formatTxError(err: unknown): Error {
  if (err instanceof SendTransactionError) {
    // `SendTransactionError` carries `.logs` (program log lines from
    // the failing simulation), but the default `.message` strips them.
    // For NTT/OnRe CPI failures the log line is the only thing that
    // distinguishes "rate limit hit" from "wrong mint" from "missing
    // account" — so always surface them when present.
    const logs = (err as SendTransactionError & { logs?: string[] | null }).logs
    const match = err.message.match(PROGRAM_ERROR_RE)
    const codeLine = match
      ? `Transaction failed: program error 0x${match[1]} (${Number.parseInt(match[1], 16)})`
      : `Transaction failed: ${err.message}`
    if (logs && logs.length > 0) {
      const tail = logs.slice(-25).map(l => `  ${l}`).join('\n')
      return new Error(`${codeLine}\nProgram logs (last 25):\n${tail}`)
    }
    return new Error(codeLine)
  }
  return err instanceof Error ? err : new Error(String(err))
}
