/**
 * `RelayerClient.initialize` must derive the config PDA from the mints it
 * actually uses. Regression for the review blocker where it took
 * `baseMint`/`assetMint` params but pinned `pairConfig` to the
 * constructor-bound `this.configPda` — an override pair then produced an
 * on-chain seed mismatch (mints from params, PDA from constructor).
 */

import { findConfigPda, RelayerClient } from '@fogo-onre/sdk'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { createProvider, createSvm } from './utils/svm'

function makeClient(pair: { baseMint: Keypair, assetMint: Keypair }) {
  const provider = createProvider(createSvm(), Keypair.generate())
  const client = new RelayerClient(provider as any, {
    baseMint: pair.baseMint.publicKey,
    assetMint: pair.assetMint.publicKey,
  })
  return { provider, client }
}

describe('initialize — config PDA tracks the pair used', () => {
  it('derives pairConfig from an override pair, not the constructor pair', async () => {
    const pairA = { baseMint: Keypair.generate(), assetMint: Keypair.generate() }
    const pairB = { baseMint: Keypair.generate(), assetMint: Keypair.generate() }
    const { provider, client } = makeClient(pairA)

    const keys = await client
      .initialize({
        authority: provider.wallet.publicKey,
        baseMint: pairB.baseMint.publicKey,
        assetMint: pairB.assetMint.publicKey,
        feeVault: Keypair.generate().publicKey,
        depositFeeBps: 0,
        withdrawFeeBps: 0,
      })
      .pubkeys()

    const [expected] = findConfigPda(pairB.baseMint.publicKey, pairB.assetMint.publicKey, client.program.programId)
    expect(keys.pairConfig?.equals(expected)).toBe(true)
    expect(keys.pairConfig?.equals(client.configPda)).toBe(false)
  })

  it('defaults to the constructor pair when no override is given', async () => {
    const pairA = { baseMint: Keypair.generate(), assetMint: Keypair.generate() }
    const { provider, client } = makeClient(pairA)

    const keys = await client
      .initialize({
        authority: provider.wallet.publicKey,
        feeVault: Keypair.generate().publicKey,
        depositFeeBps: 0,
        withdrawFeeBps: 0,
      })
      .pubkeys()

    expect(keys.pairConfig?.equals(client.configPda)).toBe(true)
  })
})
