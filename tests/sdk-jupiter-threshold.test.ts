/**
 * `fetchJupiterRoute` must let the caller pin Jupiter's on-chain
 * `otherAmountThreshold` to the user-signed floor instead of inheriting it from
 * the route-selection `slippageBps`. Regression for the Copilot finding: a
 * hardcoded 1% Jupiter slippage rejected swaps that the user's looser signed
 * `min_swap_out` (and the on-chain check) would have accepted.
 */

import { Buffer } from 'node:buffer'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { fetchJupiterRoute, JUPITER_V6_PROGRAM_ID } from '../packages/sdk/src/builders/jupiter'

const SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR = [193, 32, 155, 51, 65, 214, 156, 129]

function mockJupiter(quoteThreshold: string) {
  let swapBody: { quoteResponse: { otherAmountThreshold: string } } | undefined
  const fetchImpl = (async (_url: string, init?: { body: string }) => {
    if (!init) {
      return { ok: true, json: async () => ({ outAmount: '1000000', otherAmountThreshold: quoteThreshold, slippageBps: 100 }) }
    }
    swapBody = JSON.parse(init.body)
    return {
      ok: true,
      json: async () => ({
        swapInstruction: {
          programId: JUPITER_V6_PROGRAM_ID.toBase58(),
          accounts: Array.from({ length: 4 }, () => ({ pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true })),
          data: Buffer.from(SHARED_ACCOUNTS_ROUTE_DISCRIMINATOR).toString('base64'),
        },
        addressLookupTableAddresses: [],
      }),
    }
  }) as unknown as typeof fetch
  return { fetchImpl, getSwapBody: () => swapBody! }
}

describe('fetchJupiterRoute — caller-pinned output threshold', () => {
  const base = {
    inputMint: Keypair.generate().publicKey,
    outputMint: Keypair.generate().publicKey,
    amount: 1_000_000n,
    slippageBps: 100,
    userPublicKey: Keypair.generate().publicKey,
  }

  it('pins otherAmountThreshold to the caller floor, not the slippage quote', async () => {
    const { fetchImpl, getSwapBody } = mockJupiter('990000')
    await fetchJupiterRoute({ ...base, otherAmountThreshold: 950000n, fetchImpl })
    expect(getSwapBody().quoteResponse.otherAmountThreshold).toBe('950000')
  })

  it('leaves the quote threshold untouched when no floor is given', async () => {
    const { fetchImpl, getSwapBody } = mockJupiter('990000')
    await fetchJupiterRoute({ ...base, fetchImpl })
    expect(getSwapBody().quoteResponse.otherAmountThreshold).toBe('990000')
  })
})
