import type { Connection } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'
import { MEMO_PROGRAM_ID, parseMinSwapOutMemo } from '../builders/min-out-memo'
import { INTENT_TRANSFER_PROGRAM_ID, ONRE_INTENT_PROGRAM_ID } from '../constants'

/** Deposit may route through the OnRe fork or Fogo's program (switch-back). */
const DEFAULT_INTENT_PROGRAM_IDS: PublicKey[] = [ONRE_INTENT_PROGRAM_ID, INTENT_TRANSFER_PROGRAM_ID]

type CompiledIx = { programIdIndex: number, accountKeyIndexes: number[], data: Uint8Array }
type ParsedTx = { keys: { get: (i: number) => PublicKey | undefined }, ixs: CompiledIx[] }

/** Fetch + unify a FOGO tx into account keys + compiled instructions, or null. */
async function fetchParsedTx(fogoConnection: Connection, fogoTx: string): Promise<ParsedTx | null> {
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
  return { keys, ixs: msg.compiledInstructions }
}

/**
 * All user wallets from `bridge_ntt_tokens` source ATAs (keys[3]; SPL layout
 * mint(32)||owner(32)), deduped in order. Usually one; more only if the tx
 * batches several bridge ixs.
 */
async function allWalletsFromParsedTx(
  fogoConnection: Connection,
  parsed: ParsedTx,
  intentProgramIds: PublicKey[],
): Promise<PublicKey[]> {
  const wallets: PublicKey[] = []
  for (const ix of parsed.ixs) {
    const programId = parsed.keys.get(ix.programIdIndex)
    if (!programId || !intentProgramIds.some(p => p.equals(programId))) {
      continue
    }
    // bridge_ntt_tokens IDL: keys[3] = source ATA
    const sourceIdx = ix.accountKeyIndexes[3]
    if (sourceIdx === undefined) {
      continue
    }
    const sourceAta = parsed.keys.get(sourceIdx)
    if (!sourceAta) {
      continue
    }
    const ataInfo = await fogoConnection.getAccountInfo(sourceAta).catch(() => null)
    if (!ataInfo || ataInfo.data.length < 64) {
      continue
    }
    const wallet = new PublicKey(ataInfo.data.subarray(32, 64))
    if (!wallets.some(w => w.equals(wallet))) {
      wallets.push(wallet)
    }
  }
  return wallets
}

/** All valid `onre:mso:<n>` floors in the tx (deduped, in order). */
function allMinOutsFromParsedTx(parsed: ParsedTx): bigint[] {
  const floors: bigint[] = []
  for (const ix of parsed.ixs) {
    if (!parsed.keys.get(ix.programIdIndex)?.equals(MEMO_PROGRAM_ID)) {
      continue
    }
    const parsedMin = parseMinSwapOutMemo(new TextDecoder().decode(ix.data))
    if (parsedMin !== null && !floors.includes(parsedMin)) {
      floors.push(parsedMin)
    }
  }
  return floors
}

/**
 * Recover the user's Solana wallet from the FOGO source tx — the VAA carries
 * only PDAs, none invertible to the wallet. Null when the tx/ix/ATA isn't found.
 */
export async function deriveUserWalletFromFogoTx(
  fogoConnection: Connection,
  fogoTx: string,
  intentProgramIds: PublicKey[] = DEFAULT_INTENT_PROGRAM_IDS,
): Promise<PublicKey | null> {
  const parsed = await fetchParsedTx(fogoConnection, fogoTx)
  if (!parsed) {
    return null
  }
  return (await allWalletsFromParsedTx(fogoConnection, parsed, intentProgramIds))[0] ?? null
}

export interface RecoveredWalletAndMinOut {
  userWallet: PublicKey
  /** User-signed swap floor from the bridge tx's `onre:mso:<n>` memo. */
  minSwapOut: bigint
}

/**
 * Recover `(userWallet, minSwapOut)` from the bridge tx; the floor rides as an
 * SPL Memo (`onre:mso:<n>`). Null if either is missing (cranker
 * noops). Untrusted: a wrong floor derives a mismatched recipient PDA, so
 * `receive` reverts on-chain — no skim.
 */
/**
 * Every `(wallet, minSwapOut)` the bridge tx could encode — all
 * `bridge_ntt_tokens` source-ATA owners × all `onre:mso:<n>` memos. The
 * caller (cranker) picks the candidate whose inbox PDA derives the VAA
 * recipient, so an extra memo or bridge ix can't mask the right one. Empty
 * when no wallet or no floor is present.
 */
export async function recoverWalletAndMinOutCandidates(
  fogoConnection: Connection,
  fogoTx: string,
  intentProgramIds: PublicKey[] = DEFAULT_INTENT_PROGRAM_IDS,
): Promise<RecoveredWalletAndMinOut[]> {
  const parsed = await fetchParsedTx(fogoConnection, fogoTx)
  if (!parsed) {
    return []
  }
  const minOuts = allMinOutsFromParsedTx(parsed)
  if (minOuts.length === 0) {
    return []
  }
  const wallets = await allWalletsFromParsedTx(fogoConnection, parsed, intentProgramIds)
  const candidates: RecoveredWalletAndMinOut[] = []
  for (const userWallet of wallets) {
    for (const minSwapOut of minOuts) {
      candidates.push({ userWallet, minSwapOut })
    }
  }
  return candidates
}

/**
 * First `(wallet, minSwapOut)` candidate, or null. Back-compat single-match
 * recovery; prefer `recoverWalletAndMinOutCandidates` + matching against the
 * VAA recipient when the source tx may carry extra memos / bridge ixs.
 */
export async function recoverUserWalletAndMinOut(
  fogoConnection: Connection,
  fogoTx: string,
  intentProgramIds: PublicKey[] = DEFAULT_INTENT_PROGRAM_IDS,
): Promise<RecoveredWalletAndMinOut | null> {
  const candidates = await recoverWalletAndMinOutCandidates(fogoConnection, fogoTx, intentProgramIds)
  return candidates[0] ?? null
}
