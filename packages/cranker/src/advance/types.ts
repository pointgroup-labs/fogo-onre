import type { AnchorProvider } from '@anchor-lang/core'
import type { RelayerClient } from '@fogo-onre/sdk'
import type { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
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
  abortSignal: AbortSignal
}

export type PlannedTx = {
  label: string
  build: () => Promise<{ ixs: TransactionInstruction[], signers: Keypair[] }>
}

export type AdvanceResult
  = | { kind: 'noop', reason: string }
    | { kind: 'advanced', signatures: string[], fromStatus: string, toStatus: string }
    | { kind: 'error', error: Error, partialSignatures: string[] }
