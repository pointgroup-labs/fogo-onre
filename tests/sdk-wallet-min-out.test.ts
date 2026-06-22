/**
 * SDK guard for `recoverUserWalletAndMinOut` (Phase 3): the cranker reads
 * BOTH the user wallet and the user-signed `min_out` from the SAME FOGO
 * bridge tx it already fetches for wallet recovery. The wallet comes from
 * the `bridge_ntt_tokens` source-ATA owner (account index 3); the floor
 * comes from an SPL Memo (`onre:mso:<n>`) in the same tx.
 *
 * Both must be present and parseable, else null (cranker noops — the memo
 * is untrusted, so a missing/garbage value would derive a mismatched
 * recipient PDA and revert on-chain anyway).
 */

import type { Connection } from '@solana/web3.js'
import {
  buildMinSwapOutMemoIx,
  MEMO_PROGRAM_ID,
  ONRE_INTENT_PROGRAM_ID,
  recoverUserWalletAndMinOut,
  recoverWalletAndMinOutCandidates,
} from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

const USER_WALLET = PublicKey.unique()
const SOURCE_ATA = PublicKey.unique()
const MIN_OUT = 4_200_000n

/** SPL TokenAccount layout: mint(32) | owner(32) | ... — owner = user wallet. */
function sourceAtaData(owner: PublicKey): Buffer {
  const buf = Buffer.alloc(165)
  buf.set(owner.toBytes(), 32)
  return buf
}

/**
 * Duck-typed `Connection` with a FOGO tx carrying the intent ix (source ATA
 * at IDL position 3) and, optionally, a Memo ix carrying `memoData`.
 */
function mockConn(programId: PublicKey, memoData?: Uint8Array): Connection {
  const keys = [programId, PublicKey.unique(), PublicKey.unique(), PublicKey.unique(), SOURCE_ATA, MEMO_PROGRAM_ID]
  const compiledInstructions: { programIdIndex: number, accountKeyIndexes: number[], data: Uint8Array }[] = [
    { programIdIndex: 0, accountKeyIndexes: [1, 2, 3, 4], data: new Uint8Array() },
  ]
  if (memoData) {
    compiledInstructions.push({ programIdIndex: 5, accountKeyIndexes: [], data: memoData })
  }
  return {
    getTransaction: async () => ({
      meta: { loadedAddresses: undefined },
      transaction: {
        message: {
          getAccountKeys: () => ({ get: (i: number) => keys[i] }),
          compiledInstructions,
        },
      },
    }),
    getAccountInfo: async (pk: PublicKey) =>
      pk.equals(SOURCE_ATA) ? { data: sourceAtaData(USER_WALLET) } : null,
  } as unknown as Connection
}

describe('recoverUserWalletAndMinOut', () => {
  it('recovers wallet + min_out when both are present', async () => {
    const memo = buildMinSwapOutMemoIx(MIN_OUT).data
    const out = await recoverUserWalletAndMinOut(mockConn(ONRE_INTENT_PROGRAM_ID, memo), 'sig')
    expect(out?.userWallet.equals(USER_WALLET)).toBe(true)
    expect(out?.minSwapOut).toBe(MIN_OUT)
  })

  it('returns null when the memo is absent', async () => {
    const out = await recoverUserWalletAndMinOut(mockConn(ONRE_INTENT_PROGRAM_ID), 'sig')
    expect(out).toBeNull()
  })

  it('returns null when the memo is present but unparseable', async () => {
    const garbage = new TextEncoder().encode('not-our-memo')
    const out = await recoverUserWalletAndMinOut(mockConn(ONRE_INTENT_PROGRAM_ID, garbage), 'sig')
    expect(out).toBeNull()
  })

  it('returns null when the wallet cannot be recovered (unrelated program)', async () => {
    const memo = buildMinSwapOutMemoIx(MIN_OUT).data
    const out = await recoverUserWalletAndMinOut(mockConn(PublicKey.unique(), memo), 'sig')
    expect(out).toBeNull()
  })
})

/** Like `mockConn` but with multiple Memo ixs (extra/decoy floors). */
function mockConnMultiMemo(programId: PublicKey, memos: Uint8Array[]): Connection {
  const keys = [programId, PublicKey.unique(), PublicKey.unique(), PublicKey.unique(), SOURCE_ATA, MEMO_PROGRAM_ID]
  const compiledInstructions = [
    { programIdIndex: 0, accountKeyIndexes: [1, 2, 3, 4], data: new Uint8Array() },
    ...memos.map(data => ({ programIdIndex: 5, accountKeyIndexes: [] as number[], data })),
  ]
  return {
    getTransaction: async () => ({
      meta: { loadedAddresses: undefined },
      transaction: {
        message: {
          getAccountKeys: () => ({ get: (i: number) => keys[i] }),
          compiledInstructions,
        },
      },
    }),
    getAccountInfo: async (pk: PublicKey) =>
      pk.equals(SOURCE_ATA) ? { data: sourceAtaData(USER_WALLET) } : null,
  } as unknown as Connection
}

describe('recoverWalletAndMinOutCandidates', () => {
  it('returns a candidate per valid memo, so an extra memo cannot mask the right floor', async () => {
    const memoA = buildMinSwapOutMemoIx(MIN_OUT).data
    const memoB = buildMinSwapOutMemoIx(7_000_000n).data
    const candidates = await recoverWalletAndMinOutCandidates(mockConnMultiMemo(ONRE_INTENT_PROGRAM_ID, [memoA, memoB]), 'sig')
    expect(candidates).toHaveLength(2)
    expect(candidates.every(c => c.userWallet.equals(USER_WALLET))).toBe(true)
    expect(candidates.map(c => c.minSwapOut).sort()).toEqual([MIN_OUT, 7_000_000n].sort())
  })

  it('is empty when no valid memo is present', async () => {
    const candidates = await recoverWalletAndMinOutCandidates(mockConn(ONRE_INTENT_PROGRAM_ID), 'sig')
    expect(candidates).toHaveLength(0)
  })
})
