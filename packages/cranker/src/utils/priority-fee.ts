import type { TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { ComputeBudgetProgram } from '@solana/web3.js'

/**
 * Build a `setComputeUnitPrice` ix from the configured priority fee. Every
 * Solana leg (bridge, relayer `.rpc()`, raw `prepareTransceiverMessage`) shares
 * this one fee source, so an incident bump raises all legs uniformly. Emits the
 * ix even at zero so the call shape stays constant across submit points.
 */
export function makePriorityFeeIx(microLamports: number): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
}

/**
 * Structural test for a `VersionedTransaction` (not `instanceof`): pnpm's
 * dual-realm `@solana/web3.js` makes the SDK's tx fail `instanceof` against the
 * cranker's copy, silently routing it to legacy handling (symptom:
 * DuplicateInstruction 0x2). Detect by owning `.message` and lacking the legacy
 * `.instructions` array.
 */
export function isVersionedTransaction(tx: unknown): tx is VersionedTransaction {
  if (tx === null || typeof tx !== 'object') {
    return false
  }
  const t = tx as { message?: unknown, instructions?: unknown }
  return t.message !== undefined && !Array.isArray(t.instructions)
}
