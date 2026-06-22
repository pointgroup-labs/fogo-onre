/**
 * Two-step global admin rotation: `set_admin` stages a pending admin and
 * `accept_admin` promotes it. The proposal is admin-gated and the claim must
 * be signed by the staged key.
 */

import { RelayerClient } from '@fogo-onre/sdk'
import { Keypair } from '@solana/web3.js'
import { LiteSVM } from 'litesvm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMint, createProvider, createSvm, expectError } from './utils'

describe('admin rotation', () => {
  let svm: LiteSVM
  let admin: Keypair
  let baseMint: Keypair
  let assetMint: Keypair
  let client: RelayerClient

  function clientFor(signer: Keypair): RelayerClient {
    const provider = createProvider(svm, signer)
    return new RelayerClient(provider as any, {
      baseMint: baseMint.publicKey,
      assetMint: assetMint.publicKey,
    })
  }

  beforeEach(async () => {
    svm = createSvm()
    admin = Keypair.generate()
    baseMint = createMint(svm, admin, 6)
    assetMint = createMint(svm, admin, 6)
    client = clientFor(admin)
    await client.bootstrap().rpc()
  })

  it('rotates the admin via set-admin then accept-admin', async () => {
    const newAdmin = Keypair.generate()

    await client.setAdmin({ newAdmin: newAdmin.publicKey }).rpc()

    const newAdminClient = clientFor(newAdmin)
    await newAdminClient.acceptAdmin().rpc()

    const config = await client.program.account.globalConfig.fetch(client.globalConfigPda)
    expect(config.admin.toBase58()).toBe(newAdmin.publicKey.toBase58())
    expect(config.pendingAdmin).toBeNull()
  })

  it('rejects set-admin from a non-admin', async () => {
    const rando = Keypair.generate()
    const randoClient = clientFor(rando)

    await expectError(
      () => randoClient.setAdmin({ newAdmin: Keypair.generate().publicKey }).rpc(),
      'UnauthorizedAdmin',
    )
  })

  it('rejects accept-admin signed by the wrong key', async () => {
    const newAdmin = Keypair.generate()
    await client.setAdmin({ newAdmin: newAdmin.publicKey }).rpc()

    const wrong = Keypair.generate()
    const wrongClient = clientFor(wrong)

    await expectError(
      () => wrongClient.acceptAdmin().rpc(),
      'PendingAdminMismatch',
    )
  })

  it('rejects set-admin proposing the current admin', async () => {
    await expectError(
      () => client.setAdmin({ newAdmin: admin.publicKey }).rpc(),
      'PendingAdminIsCurrent',
    )
  })

  it('rejects accept-admin when nothing is staged', async () => {
    await expectError(() => client.acceptAdmin().rpc(), 'NoPendingAdmin')
  })
})
