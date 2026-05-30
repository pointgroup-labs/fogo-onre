import type { Connection } from '@solana/web3.js'
import {
  deriveUserWalletFromFogoTx,
  INTENT_TRANSFER_PROGRAM_ID,
  ONRE_INTENT_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

const USER_WALLET = PublicKey.unique()
const SOURCE_ATA = PublicKey.unique()

/** SPL TokenAccount layout: mint(32) | owner(32) | ... — owner = user wallet. */
function sourceAtaData(owner: PublicKey): Buffer {
  const buf = Buffer.alloc(165)
  buf.set(owner.toBytes(), 32)
  return buf
}

/**
 * Duck-typed `Connection` whose single FOGO tx carries one instruction
 * targeting `programId`, with the source ATA at IDL position 3.
 */
function mockConn(programId: PublicKey): Connection {
  const keys = [programId, PublicKey.unique(), PublicKey.unique(), PublicKey.unique(), SOURCE_ATA]
  return {
    getTransaction: async () => ({
      meta: { loadedAddresses: undefined },
      transaction: {
        message: {
          getAccountKeys: () => ({ get: (i: number) => keys[i] }),
          compiledInstructions: [
            { programIdIndex: 0, accountKeyIndexes: [1, 2, 3, 4], data: new Uint8Array() },
          ],
        },
      },
    }),
    getAccountInfo: async (pk: PublicKey) =>
      pk.equals(SOURCE_ATA) ? { data: sourceAtaData(USER_WALLET) } : null,
  } as unknown as Connection
}

describe('deriveUserWalletFromFogoTx fork program id', () => {
  it('recovers the wallet when the tx targets the OnRe fork program id', async () => {
    const recovered = await deriveUserWalletFromFogoTx(mockConn(ONRE_INTENT_PROGRAM_ID), 'sig')
    expect(recovered?.equals(USER_WALLET)).toBe(true)
  })

  it('still recovers under the Fogo program id (switch-back)', async () => {
    const recovered = await deriveUserWalletFromFogoTx(mockConn(INTENT_TRANSFER_PROGRAM_ID), 'sig')
    expect(recovered?.equals(USER_WALLET)).toBe(true)
  })

  it('returns null for an unrelated program id', async () => {
    const recovered = await deriveUserWalletFromFogoTx(mockConn(PublicKey.unique()), 'sig')
    expect(recovered).toBeNull()
  })
})
