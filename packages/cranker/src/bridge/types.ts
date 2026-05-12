import type { NttManagerMode } from '@fogo-onre/sdk'
import type { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { Metrics } from '../metrics'
import type { Logger } from '../utils/log'

/**
 * One direction of cross-chain VAA bridging the cranker can drive.
 *
 * The cranker has exactly **one** of these in production today
 * (Solana ONyc → FOGO ONyc, the leg `lock_onyc.rs` produces but doesn't
 * relay). We model it as a struct rather than wiring everything inline
 * so the redeem engine stays unit-testable without spinning up real
 * Connections, and so the inevitable second target (e.g. a return path)
 * doesn't tempt anyone to copy-paste the entire pipeline.
 *
 * Deliberately NOT a registry / dispatch table — codex flagged that as
 * over-engineering for a registry-of-one. A second target adds a second
 * call site, not a second abstraction layer.
 */
export interface BridgeRedeemTarget {
  /**
   * Stable label for logs + metrics — must be a static string so the
   *  Prometheus cardinality is bounded.
   */
  name: string
  /** Wormhole chain id of the *source* chain (where the VAA was emitted). */
  sourceChainId: number
  /** Hex emitter of the source NTT manager (32 bytes, no 0x). */
  sourceEmitterHex: string
  /**
   * Wormhole chain id of the *destination* chain (where redeem lands).
   *  Used as the gating filter so a stray same-emitter VAA addressed to
   *  a different chain isn't silently submitted.
   */
  destChainId: number
  destConnection: Connection
  destNttManagerProgramId: PublicKey
  /**
   * Wormhole-transceiver program id. NTT v3 supports two transceiver
   * modes: standalone (separate program) and bundled (transceiver
   * lives inside the manager program). Our deploy uses **bundled**
   * mode, so this field equals `destNttManagerProgramId` — both
   * `registered_transceiver` PDA seeding and `receive_message` CPI
   * dispatch target the manager. Kept as a separate field so a future
   * standalone-mode deploy can override without touching call sites.
   */
  destWhTransceiverProgramId: PublicKey
  destMint: PublicKey
  /** Keypair that pays + signs `redeem` + `release_inbound_*` on dest. */
  destSigner: Keypair
  /**
   * Mode of the destination NTT manager — probed once at daemon startup
   *  via `decodeNttConfig` and asserted to match this declared value.
   *  Picks the release variant (`mint` for Burning, `unlock` for Locking).
   */
  destReleaseMode: NttManagerMode
  /**
   * `true` iff the dest-side NTT manager has the per-source-chain
   * governance state needed for redeem to succeed:
   *   - `peer` PDA for `sourceChainId`
   *   - `registered_transceiver` PDA for the configured transceiver
   *   - `inbox_rate_limit` PDA for `sourceChainId`
   *
   * NTT's `redeem` aborts with `AccountDiscriminatorNotFound (0xbb9)`
   * when any of those is empty. Probed once at startup; if false the
   * planner refuses to submit so we don't burn SOL on a tx that always
   * fails on-chain.
   */
  configReady: boolean
  /** Human-readable reason captured when `configReady=false`. */
  configError?: string
}

export interface BridgeMetrics {
  redeemed: { inc: (labels: { target: string, result: string }) => void }
  txSent: Metrics['txSent']
  rpcErrors: Metrics['rpcErrors']
}

export interface BridgeContext {
  log: Logger
  metrics: BridgeMetrics
  abortSignal: AbortSignal
  wormholescanUrl: string
  wormholescanTimeoutMs: number
  rpcTimeoutMs: number
  txConfirmTimeoutMs: number
  /** Priority fee in micro-lamports/CU prepended to every bridge submission. */
  priorityFeeMicroLamports: number
}

export type BridgeRedeemResult
  = | { kind: 'submitted', signature: string, action: 'redeem-and-release' | 'release-only' }
    | { kind: 'noop', reason: string }
    | { kind: 'error', error: Error }

/**
 * The pre-tx work of a bridge redeem: instructions to add (or empty
 * if no-op) plus a description of what action will be taken. Split out
 * so the engine and tests can reason about decisions without actually
 * sending.
 */
export interface BridgePlan {
  action: 'redeem-and-release' | 'release-only' | 'noop'
  reason?: string
  ixs: TransactionInstruction[]
}
