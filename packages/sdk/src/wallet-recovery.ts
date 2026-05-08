import type { Connection } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { INTENT_TRANSFER_PROGRAM_ID } from './constants'

/**
 * Recover the user's Solana wallet from the FOGO source tx that emitted
 * the deposit VAA.
 *
 * Required because the VAA carries only the per-user inbox PDA
 * (recipient) and the `intent_transfer_setter` PDA (sender) — neither
 * is invertible to the user wallet. The original FOGO `bridge_ntt_tokens`
 * ix has the source ATA at IDL position 3; that ATA's `owner` field
 * (SPL TokenAccount layout: mint(32) || owner(32)) IS the user wallet.
 *
 * Two RPCs per uncached VAA: `getTransaction(fogoTx)` +
 * `getAccountInfo(sourceAta)`. Returns null when the tx isn't findable,
 * doesn't contain a `bridge_ntt_tokens` ix, or the source ATA can't be
 * read.
 */
export async function deriveUserWalletFromFogoTx(
  fogoConnection: Connection,
  fogoTx: string,
): Promise<PublicKey | null> {
  if (!fogoTx) {
    return null
  }
  const tx = await fogoConnection.getTransaction(fogoTx, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  }).catch(() => null)
  if (!tx) {
    return null
  }
  const msg = tx.transaction.message
  // Versioned + legacy unify under `getAccountKeys` in @solana/web3.js 1.95+.
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses })
  for (const ix of msg.compiledInstructions) {
    const programId = keys.get(ix.programIdIndex)
    if (!programId?.equals(INTENT_TRANSFER_PROGRAM_ID)) {
      continue
    }
    // intent_transfer.bridge_ntt_tokens IDL: keys[3] = source ATA
    // (see packages/sdk/src/builders/intent-transfer.ts).
    const sourceIdx = ix.accountKeyIndexes[3]
    if (sourceIdx === undefined) {
      continue
    }
    const sourceAta = keys.get(sourceIdx)
    if (!sourceAta) {
      continue
    }
    const ataInfo = await fogoConnection.getAccountInfo(sourceAta).catch(() => null)
    if (!ataInfo || ataInfo.data.length < 64) {
      continue
    }
    return new PublicKey(ataInfo.data.subarray(32, 64))
  }
  return null
}
