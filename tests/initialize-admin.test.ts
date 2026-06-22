/**
 * Admin-gated pair creation: `bootstrap` writes the singleton GlobalConfig
 * admin, and `initialize` is then only callable by that admin. A pair
 * init signed by any other key must revert with `UnauthorizedAdmin`.
 */

import { RelayerClient } from '@fogo-onre/sdk'
import { Keypair } from '@solana/web3.js'
import { LiteSVM } from 'litesvm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAta, createMint, createProvider, createSvm, expectError } from './utils'

describe('initialize admin gate', () => {
  let svm: LiteSVM
  let admin: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  let feeVault: ReturnType<typeof createAta>

  beforeEach(() => {
    svm = createSvm()
    admin = Keypair.generate()
    const provider = createProvider(svm, admin)
    baseMint = createMint(svm, admin, 6)
    assetMint = createMint(svm, admin, 6)
    client = new RelayerClient(provider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })
    feeVault = createAta(svm, admin, assetMint.publicKey, admin.publicKey)
  })

  it('lets the admin create a pair after global init', async () => {
    await client.bootstrap().rpc()
    await client
      .initialize({
        authority: admin.publicKey,
        baseMint: baseMint.publicKey,
        assetMint: assetMint.publicKey,
        feeVault,
        depositFeeBps: 50,
        withdrawFeeBps: 100,
      })
      .rpc()

    const config = await client.fetchConfig()
    expect(config.authority.toBase58()).toBe(admin.publicKey.toBase58())
  })

  it('rejects a pair init signed by a non-admin', async () => {
    await client.bootstrap().rpc()

    const rando = Keypair.generate()
    svm.airdrop(rando.publicKey, BigInt(1e9))

    await expectError(
      () =>
        client
          .initialize({
            authority: rando.publicKey,
            baseMint: baseMint.publicKey,
            assetMint: assetMint.publicKey,
            feeVault,
            depositFeeBps: 50,
            withdrawFeeBps: 100,
          })
          .signers([rando])
          .rpc(),
      'UnauthorizedAdmin',
    )
  })
})
