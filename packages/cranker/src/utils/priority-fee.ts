import type { TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { ComputeBudgetProgram } from '@solana/web3.js'

/**
 * Build a `setComputeUnitPrice` instruction with the configured
 * priority fee. Mainnet validators schedule pending txs by
 * micro-lamports-per-CU; a tx without this instruction sits at the
 * bottom of every leader's queue and routinely expires
 * (`TransactionExpiredBlockheightExceededError`) before inclusion.
 *
 * The cranker prepends this to every Solana submission. Bridge txs,
 * relayer Anchor `.rpc()` calls (via `preInstructions`), and the raw
 * `prepareTransceiverMessage` sequence all share the same fee
 * source — `cfg.solanaPriorityFeeMicroLamports` — so a single env
 * bump during an incident raises every leg uniformly on the next
 * scan.
 *
 * `microLamports === 0` returns the instruction anyway. Setting an
 * explicit zero is semantically identical to omitting the ix, but
 * keeping the call shape constant simplifies test assertions and
 * avoids a conditional at every submit point.
 */
export function makePriorityFeeIx(microLamports: number): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
}

/**
 * Structural test for a `VersionedTransaction` instance.
 *
 * **Why not `instanceof`:** pnpm's content-addressed store can resolve
 * multiple physical copies of `@solana/web3.js` for the same semver
 * range when transitive peers differ — the Wormhole/NTT SDK builds its
 * yielded txs against ONE copy while the cranker imports from ANOTHER,
 * so `instanceof VersionedTransaction` returns `false` for what is
 * functionally a versioned tx and silently routes it into legacy
 * handling. The symptom that bit us: DuplicateInstruction = 0x2,
 * because the legacy path didn't strip the SDK's embedded
 * `setComputeUnitPrice`.
 *
 * **Detection:** versioned txs own `.message` and lack the legacy
 * `.instructions` array. We check both to avoid false positives from
 * exotic shapes (e.g. a plain object literal with `.message`).
 */
export function isVersionedTransaction(tx: unknown): tx is VersionedTransaction {
  if (tx === null || typeof tx !== 'object') {
    return false
  }
  const t = tx as { message?: unknown, instructions?: unknown }
  return t.message !== undefined && !Array.isArray(t.instructions)
}
