import type { AnchorProvider } from '@anchor-lang/core'
import type { RelayerClient } from '@fogo-onre/sdk'
import type { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { Logger } from '../log'
import type { Metrics } from '../metrics'

export type AdvanceContext = {
  connection: Connection
  fogoConnection: Connection
  provider: AnchorProvider
  client: RelayerClient
  keypair: Keypair
  relayerProgramId: PublicKey
  wormholescanUrl: string
  wormholescanTimeoutMs: number
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

export type AdvanceResult
  = | { kind: 'noop', reason: string }
    | { kind: 'advanced', signatures: string[], fromStatus: string, toStatus: string }
    | { kind: 'error', error: Error, partialSignatures: string[] }
