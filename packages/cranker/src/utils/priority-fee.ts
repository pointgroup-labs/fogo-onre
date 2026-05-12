import type { Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
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
 * Compute-budget instruction discriminator for `SetComputeUnitPrice`.
 * The compute-budget program rejects a tx that contains two of the
 * same directive with `InstructionError::Custom(2)` (DuplicateInstruction),
 * attributed to the duplicate index — and the Wormhole/NTT SDK quietly
 * embeds its own `setComputeUnitPrice` into the txs yielded by
 * `core.postVaa(...)` and `ntt.redeem(...)`. Prepending our own ix
 * without filtering the SDK's would dupe and abort simulation.
 *
 * `SetComputeUnitLimit` (discriminator 2) is intentionally kept: the
 * SDK sizes it for the work in that specific tx and dropping it could
 * leave us under the 200k default. We only own the *price*; the
 * budget* is the SDK's call.
 */
const CB_DISCRIMINATOR_SET_COMPUTE_UNIT_PRICE = 3

/**
 * Inject our priority-fee ix into an instruction list while stripping
 * any pre-existing `setComputeUnitPrice` the upstream SDK may have
 * added. Used by the decompile-prepend-recompile path in
 * `prepareTransceiverMessage` (non-shim postVaa loop) and `sdk-redeem`
 * (redeem-bundle loop) — both consume SDK-yielded VersionedTransactions
 * that already contain compute-budget pricing.
 */
export function injectPriorityFee(
  ixs: TransactionInstruction[],
  priorityFeeIx: TransactionInstruction,
): TransactionInstruction[] {
  const filtered = ixs.filter((ix) => {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) {
      return true
    }
    const data = ix.data
    // Defensive: a zero-length compute-budget ix is malformed but
    // shouldn't crash the filter. Treat as "not a price" → keep.
    if (data.length === 0) {
      return true
    }
    return data[0] !== CB_DISCRIMINATOR_SET_COMPUTE_UNIT_PRICE
  })
  return [priorityFeeIx, ...filtered]
}

/**
 * Structural test for a legacy `Transaction` instance.
 *
 * **Why not `instanceof`:** pnpm's content-addressed store can resolve
 * multiple physical copies of `@solana/web3.js` for the same semver
 * range when transitive peers differ (e.g. one consumer pulls
 * `typescript@6.0.2`, another pulls `typescript@6.0.3` — each gets a
 * distinct content hash, each exports its own `VersionedTransaction`
 * and `Transaction` constructors). The Wormhole/NTT SDK builds its
 * yielded txs against ONE copy; our cranker imports
 * `VersionedTransaction` from ANOTHER. `inner instanceof
 * VersionedTransaction` then returns `false` even for what is
 * functionally a versioned tx, silently routing us into legacy
 * handling and producing nonsense on-the-wire (the symptom that bit
 * us: DuplicateInstruction = 0x2 at ix index 1, because the legacy
 * mutation path didn't actually strip the SDK's embedded
 * `setComputeUnitPrice`).
 *
 * **Detection:** legacy `Transaction` has a top-level mutable
 * `instructions: TransactionInstruction[]` array. `VersionedTransaction`
 * does not — instead it owns a `.message` (MessageV0 / Message). The
 * presence of `.instructions` as an array is a robust, realm-
 * independent discriminator.
 */
export function isLegacyTransaction(tx: unknown): tx is Transaction {
  return tx !== null
    && typeof tx === 'object'
    && Array.isArray((tx as { instructions?: unknown }).instructions)
}

/**
 * Structural test for a `VersionedTransaction` instance. Companion to
 * `isLegacyTransaction` — same dual-realm rationale.
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
