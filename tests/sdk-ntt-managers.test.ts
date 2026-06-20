/**
 * Config-driven NTT managers. The program stores per-pair NTT managers in
 * `PairConfig`; the SDK must route `receive`/`send`/`refund` through THOSE,
 * not the hardcoded OnRe USDC/ONyc constants — otherwise a non-OnRe pair
 * bridges through the wrong NTT programs. Regression for the review blocker.
 *
 * `receive` exposes the inbound manager as the named `nttProgram` account, so
 * `.pubkeys()` can assert it directly (deposit pulls in the BASE token →
 * base manager; withdraw → asset manager).
 */

import { RelayerClient } from '@fogo-onre/sdk'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { createProvider, createSvm } from './utils/svm'

function makeClient() {
  const provider = createProvider(createSvm(), Keypair.generate())
  const baseMint = Keypair.generate()
  const assetMint = Keypair.generate()
  const client = new RelayerClient(provider as any, {
    baseMint: baseMint.publicKey,
    assetMint: assetMint.publicKey,
  })
  return { provider, client, baseMint, assetMint }
}

describe('receive — config-driven NTT manager', () => {
  it('deposit routes through the provided base manager, not the OnRe default', async () => {
    const { provider, client, baseMint } = makeClient()
    const customBase = Keypair.generate().publicKey
    const customAsset = Keypair.generate().publicKey

    const keys = await client
      .receive({
        payer: provider.wallet.publicKey,
        direction: { deposit: {} },
        userWallet: Keypair.generate().publicKey,
        recvMint: baseMint.publicKey,
        minSwapOut: 1n,
        nttInboxItem: Keypair.generate().publicKey,
        nttTransceiverMessage: Keypair.generate().publicKey,
        nttBaseProgram: customBase,
        nttAssetProgram: customAsset,
      })
      .pubkeys()

    expect(keys.nttProgram?.equals(customBase)).toBe(true)
  })

  it('withdraw routes through the provided asset manager', async () => {
    const { provider, client, assetMint } = makeClient()
    const customBase = Keypair.generate().publicKey
    const customAsset = Keypair.generate().publicKey

    const keys = await client
      .receive({
        payer: provider.wallet.publicKey,
        direction: { withdraw: {} },
        userWallet: Keypair.generate().publicKey,
        recvMint: assetMint.publicKey,
        minSwapOut: 1n,
        nttInboxItem: Keypair.generate().publicKey,
        nttTransceiverMessage: Keypair.generate().publicKey,
        nttBaseProgram: customBase,
        nttAssetProgram: customAsset,
      })
      .pubkeys()

    expect(keys.nttProgram?.equals(customAsset)).toBe(true)
  })
})
