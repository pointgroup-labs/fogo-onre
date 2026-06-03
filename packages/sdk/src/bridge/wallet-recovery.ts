import type { Connection } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { INTENT_TRANSFER_PROGRAM_ID, ONRE_INTENT_PROGRAM_ID } from '../constants'

/** Deposit may route through the OnRe fork or Fogo's program (switch-back). */
const DEFAULT_INTENT_PROGRAM_IDS: PublicKey[] = [ONRE_INTENT_PROGRAM_ID, INTENT_TRANSFER_PROGRAM_ID]

/**
 * Recover the user's Solana wallet from the FOGO source tx that emitted
 * the deposit VAA. Needed because the VAA carries only the inbox PDA and
 * setter PDA, neither invertible to the wallet. The source ATA at IDL
 * position 3 of `bridge_ntt_tokens` has the wallet in its `owner` field
 * (SPL layout: mint(32) || owner(32)).
 *
 * Two RPCs per uncached VAA. Returns null when the tx/ix/ATA isn't findable.
 */
export async function deriveUserWalletFromFogoTx(
  fogoConnection: Connection,
  fogoTx: string,
  intentProgramIds: PublicKey[] = DEFAULT_INTENT_PROGRAM_IDS,
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
    if (!programId || !intentProgramIds.some(p => p.equals(programId))) {
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
