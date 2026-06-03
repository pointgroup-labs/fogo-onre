import type { AnchorProvider } from '@anchor-lang/core'
import type { RelayerClient } from '@fogo-onre/sdk'
import type { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { Metrics } from '../metrics'
import type { Logger } from '../utils/log'

export type AdvanceContext = {
  connection: Connection
  fogoConnection: Connection
  provider: AnchorProvider
  client: RelayerClient
  keypair: Keypair
  relayerProgramId: PublicKey
  wormholescanUrl: string
  wormholescanTimeoutMs: number
  rpcTimeoutMs: number
  /**
   * Per-transaction confirm budget. Distinct from `rpcTimeoutMs`
   * because `core.postVaa` is a multi-tx sequence (verify_signatures
   * + post_vaa) where each tx is confirmed individually, and mainnet
   * congestion routinely pushes per-tx confirm to 20–40 s. Using
   * `rpcTimeoutMs` (15 s default) here aborts mid-sequence and leaves
   * the flow `Pending` until the next scan.
   */
  txConfirmTimeoutMs: number
  /**
   * Priority fee in micro-lamports/CU prepended to every Solana
   * submission this advance fires. Sourced from
   * `cfg.solanaPriorityFeeMicroLamports`. See
   * `utils/priority-fee.ts` for rationale.
   */
  priorityFeeMicroLamports: number
  /**
   * Optional Address Lookup Table compressing the `send` leg's stable
   * NTT/Wormhole accounts so the v0 tx fits under 1232 bytes. When unset,
   * the send tx is built without compression and will overflow.
   */
  sendLookupTable?: PublicKey
  metrics: Metrics
  /** Structured logger; threaded through scan + enumerate + (future) advance fns. */
  log: Logger
  abortSignal: AbortSignal
  /**
   * Cross-scan cache: FOGO source-tx signature → user wallet (Solana
   * pubkey of the depositor). The VAA carries only a PDA recipient and a
   * setter-PDA sender — neither is invertible to the user wallet — so
   * `claim_usdc` resolves it by reading the original FOGO tx's
   * `bridge_ntt_tokens` source ATA owner. Two RPCs per first sighting,
   * zero on subsequent scans. Owned by the daemon (one Map per process).
   */
  userWalletCache: Map<string, PublicKey>
}

export type PlannedTx = {
  label: string
  build: () => Promise<{ ixs: TransactionInstruction[], signers: Keypair[] }>
}

/**
 * `severity` distinguishes routine noops (raced by another cranker,
 * race-classifier rejected, etc — expected operating noise) from
 * operator-actionable configuration gates (FOGO peer not registered,
 * placeholder constants in place, registered-transceiver PDA missing).
 * The scan-loop logger surfaces `config` noops at WARN so deployment
 * mistakes don't hide under default-info log level the way they used to.
 *
 * Optional with implicit `routine` default — existing call sites that
 * pre-date this field continue to behave exactly as before.
 */
export type NoopSeverity = 'routine' | 'config'

export type AdvanceResult
  = | { kind: 'noop', reason: string, severity?: NoopSeverity }
    | { kind: 'advanced', signatures: string[], fromStatus: string, toStatus: string }
    | { kind: 'error', error: Error, partialSignatures: string[] }
