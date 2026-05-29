/**
 * `migrate_config` one-shot upgrade of a pre-`slippage_bps` `RelayerConfig`.
 *
 * `slippage_bps` was appended to `RelayerConfig` after mainnet launch, so the
 * live account is 2 bytes short of the current layout and every typed load of
 * it fails until `migrate_config` runs. These tests craft a faithful V0
 * account (old layout, no slippage field) and assert the migration grows it,
 * preserves every prior field, and seeds `slippage_bps = DEFAULT_SLIPPAGE_BPS`.
 */
import type { LiteSVM } from 'litesvm'
import {
  DEFAULT_SLIPPAGE_BPS,
  findAuthorityPda,
  findConfigPda,
  RelayerClient,
} from '@fogo-onre/sdk'
import { Keypair, PublicKey } from '@solana/web3.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAta, createMint, createProvider, createSvm, expectError } from './utils'

// `account:RelayerConfig` Anchor discriminator (from the generated IDL).
const RELAYER_CONFIG_DISCRIMINATOR = Buffer.from([116, 239, 42, 132, 218, 154, 194, 20])

// Frozen size of the pre-`slippage_bps` mainnet account, allocated as
// `8 + V0::INIT_SPACE`: 8 disc + 4*32 mints/keys + 2*2 fees + 2 bumps
// + (1+32) pending_authority + (1+14) pending_fee = 190 bytes.
const V0_LEN = 190

describe('migrate_config', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let usdcMint: Keypair
  let onycMint: Keypair
  let feeVault: PublicKey

  beforeEach(() => {
    svm = createSvm()
    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    client = new RelayerClient(provider as any)
    usdcMint = createMint(svm, authority, 6)
    onycMint = createMint(svm, authority, 6)
    feeVault = createAta(svm, authority, onycMint.publicKey, authority.publicKey)
  })

  /**
   * Stomp the config PDA to the frozen pre-slippage (V0) layout with
   * distinctive fee values, simulating the live mainnet account.
   */
  function seedV0Config(depositFeeBps: number, withdrawFeeBps: number): {
    configPda: PublicKey
    newLen: number
  } {
    const [configPda, configBump] = findConfigPda(client.program.programId)
    const [, authBump] = findAuthorityPda(client.program.programId)
    const newLen = client.program.account.relayerConfig.size

    const data = Buffer.alloc(V0_LEN)
    RELAYER_CONFIG_DISCRIMINATOR.copy(data, 0)
    usdcMint.publicKey.toBuffer().copy(data, 8)
    onycMint.publicKey.toBuffer().copy(data, 40)
    authority.publicKey.toBuffer().copy(data, 72)
    feeVault.toBuffer().copy(data, 104)
    data.writeUInt16LE(depositFeeBps, 136)
    data.writeUInt16LE(withdrawFeeBps, 138)
    data.writeUInt8(authBump, 140)
    data.writeUInt8(configBump, 141)
    data.writeUInt8(0, 142) // pending_authority: None
    data.writeUInt8(0, 143) // pending_fee: None

    // Rent-exempt for the OLD size only — forces the handler's top-up path.
    const lamports = Number(svm.minimumBalanceForRentExemption(BigInt(V0_LEN)))
    svm.setAccount(configPda, {
      executable: false,
      owner: client.program.programId,
      lamports,
      data,
      rentEpoch: 0,
    })
    return { configPda, newLen }
  }

  it('upgrades a V0 account, preserving fields and seeding default slippage', async () => {
    const { configPda, newLen } = seedV0Config(37, 88)

    await client.migrateConfig({ authority: authority.publicKey }).rpc()

    const cfg = await client.fetchConfig()
    expect(cfg.authority.toBase58()).toBe(authority.publicKey.toBase58())
    expect(cfg.usdcMint.toBase58()).toBe(usdcMint.publicKey.toBase58())
    expect(cfg.onycMint.toBase58()).toBe(onycMint.publicKey.toBase58())
    expect(cfg.feeVault.toBase58()).toBe(feeVault.toBase58())
    expect(cfg.depositFeeBps).toBe(37)
    expect(cfg.withdrawFeeBps).toBe(88)
    expect(cfg.pendingAuthority).toBeNull()
    expect(cfg.pendingFee).toBeNull()
    expect(cfg.slippageBps).toBe(DEFAULT_SLIPPAGE_BPS)

    const account = svm.getAccount(configPda)
    expect(account?.data.length).toBe(newLen)
  })

  it('is idempotent — reverts once already migrated', async () => {
    seedV0Config(10, 20)
    await client.migrateConfig({ authority: authority.publicKey }).rpc()
    // Advance the blockhash so the retry isn't a byte-identical, deduped tx.
    svm.expireBlockhash()
    await expectError(
      () => client.migrateConfig({ authority: authority.publicKey }).rpc(),
      'ConfigAlreadyMigrated',
    )
  })

  it('rejects a non-authority signer', async () => {
    seedV0Config(10, 20)
    const attacker = Keypair.generate()
    const attackerClient = new RelayerClient(createProvider(svm, attacker) as any)
    await expectError(
      () => attackerClient.migrateConfig({ authority: attacker.publicKey }).rpc(),
      'UnauthorizedAuthority',
    )
  })
})
