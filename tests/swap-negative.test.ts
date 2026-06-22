/**
 * Negative / security tests for the permissionless `swap` handler.
 *
 * The honest success path lives in `swap-onyc-to-usdc-e2e.test.ts`; here we
 * drive the committed `evil_router` (modes 0–3) plus hand-crafted forbidden
 * accounts to prove each value-floor and custody guard fires with its own
 * error: the pre-CPI custody-exclusion loop (SwapAccountNotAllowed), the
 * exact-consume check (InputConsumedMismatch), the signed-floor guard
 * (OutputBelowFloor), the post-CPI ATA assertion (AtaAuthorityTampered), and
 * the relayer-authority lamports/owner/data guard (RelayerAuthorityTampered).
 */

import { BN } from '@anchor-lang/core'
import {
  findAuthorityPda,
  findOutflightFlowPda,
  RelayerClient,
} from '@fogo-onre/sdk'
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, PublicKey } from '@solana/web3.js'
import { Clock, LiteSVM } from 'litesvm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createAta,
  createMint,
  createProvider,
  createSvm,
  createTokenAccount,
} from './utils'

const ROUTER_ID = new PublicKey('8uyMF1riG7YSjvPrJcd5VbRaDCnYeqWyPe6HzMevn4bT')
const POOL_AUTH_SEED = Buffer.from('pool_auth')

type Meta = { pubkey: PublicKey, isSigner: boolean, isWritable: boolean }
const meta = (pubkey: PublicKey, isWritable = true): Meta => ({ pubkey, isSigner: false, isWritable })

describe('swap negatives (malicious router + custody guards)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  let relayerAuthorityPda: PublicKey
  let feeVault: PublicKey
  let poolAuthority: PublicKey
  let assetAta: PublicKey
  let baseAta: PublicKey
  let poolAsset: PublicKey
  let poolBase: PublicKey
  let nttInboxItem: PublicKey
  let outflightFlowPda: PublicKey

  const grossOnyc = 500_000n
  const withdrawFeeBps = 100
  const feeOnyc = (grossOnyc * BigInt(withdrawFeeBps)) / 10_000n // 5_000
  const netOnyc = grossOnyc - feeOnyc // 495_000
  const outUsdc = 5_000_000n // comfortably above the signed floor
  const MIN_USDC_FLOOR = 100_000n // flow.min_swap_out for the seeded flow

  // honest router ix data: [mode][in_amount LE][out_amount LE]
  const ixData = (mode: number, inAmount: bigint, outAmount: bigint): Buffer => {
    const d = Buffer.alloc(17)
    d.writeUInt8(mode, 0)
    d.writeBigUInt64LE(inAmount, 1)
    d.writeBigUInt64LE(outAmount, 9)
    return d
  }

  // Honest 7-entry account order (see evil_router/src/lib.rs).
  const honestAccounts = (): Meta[] => [
    meta(assetAta),
    meta(baseAta),
    meta(poolAsset),
    meta(poolBase),
    meta(relayerAuthorityPda, false),
    meta(poolAuthority, false),
    meta(TOKEN_PROGRAM_ID, false),
  ]

  const runSwap = (args: {
    swapProgram: PublicKey
    swapIxData: Buffer
    swapAccounts: Meta[]
  }) =>
    client
      .swap({
        flowPda: outflightFlowPda,
        baseMint: baseMint.publicKey,
        assetMint: assetMint.publicKey,
        feeVault,
        nttInboxItem,
        swapProgram: args.swapProgram,
        swapDelegate: relayerAuthorityPda,
        swapIxData: args.swapIxData,
        swapAccounts: args.swapAccounts,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc()

  beforeEach(async () => {
    svm = createSvm()
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

    authority = Keypair.generate()
    const provider = createProvider(svm, authority)

    baseMint = createMint(svm, authority, 6)
    assetMint = createMint(svm, authority, 6)
    client = new RelayerClient(provider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    ;[poolAuthority] = PublicKey.findProgramAddressSync([POOL_AUTH_SEED], ROUTER_ID)

    feeVault = createAta(svm, authority, assetMint.publicKey, authority.publicKey)

    await client.bootstrap().rpc()
    await client
      .initialize({
        authority: authority.publicKey,
        baseMint: baseMint.publicKey,
        assetMint: assetMint.publicKey,
        feeVault,
        depositFeeBps: 50,
        withdrawFeeBps,
      })
      .rpc()

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))

    assetAta = getAssociatedTokenAddressSync(assetMint.publicKey, relayerAuthorityPda, true)
    baseAta = getAssociatedTokenAddressSync(baseMint.publicKey, relayerAuthorityPda, true)
    // Seed a little extra ONyc so an over-consume pull doesn't underflow the
    // token account before the in_consumed check can fire (Step 3).
    createTokenAccount(svm, assetAta, assetMint.publicKey, relayerAuthorityPda, grossOnyc + 10n)
    createTokenAccount(svm, baseAta, baseMint.publicKey, relayerAuthorityPda, 0n)

    poolAsset = getAssociatedTokenAddressSync(assetMint.publicKey, poolAuthority, true)
    poolBase = getAssociatedTokenAddressSync(baseMint.publicKey, poolAuthority, true)
    createTokenAccount(svm, poolAsset, assetMint.publicKey, poolAuthority, 0n)
    createTokenAccount(svm, poolBase, baseMint.publicKey, poolAuthority, outUsdc)

    nttInboxItem = Keypair.generate().publicKey
    let flowBump: number
    ;[outflightFlowPda, flowBump] = findOutflightFlowPda(client.configPda, nttInboxItem, client.program.programId)
    const flowData = await client.program.coder.accounts.encode('flow', {
      recipient: new PublicKey(new Uint8Array(32).fill(7)),
      status: { received: {} },
      amount: new BN(grossOnyc.toString()),
      payer: authority.publicKey,
      bump: flowBump,
      direction: { withdraw: {} },
      // User-signed floor: the honest out (outUsdc) clears it; the signed-floor
      // negative (out = 1) falls below and must revert.
      minSwapOut: new BN(MIN_USDC_FLOOR.toString()),
      receivedSlot: new BN(0),
    })
    svm.setAccount(outflightFlowPda, {
      executable: false,
      owner: client.program.programId,
      lamports: 2_000_000,
      data: flowData,
      rentEpoch: 0,
    })
  })

  describe('step 1 — pre-CPI exclusion of forbidden singletons', () => {
    it('rejects fee_vault appended as a swap account', async () => {
      await expect(runSwap({
        swapProgram: PublicKey.default,
        swapIxData: ixData(0, netOnyc, outUsdc),
        swapAccounts: [...honestAccounts(), meta(feeVault)],
      })).rejects.toThrow(/SwapAccountNotAllowed/)
    })

    it('rejects relayer_config appended as a swap account', async () => {
      await expect(runSwap({
        swapProgram: PublicKey.default,
        swapIxData: ixData(0, netOnyc, outUsdc),
        swapAccounts: [...honestAccounts(), meta(client.configPda)],
      })).rejects.toThrow(/SwapAccountNotAllowed/)
    })

    it('rejects the flow PDA appended as a swap account', async () => {
      await expect(runSwap({
        swapProgram: PublicKey.default,
        swapIxData: ixData(0, netOnyc, outUsdc),
        swapAccounts: [...honestAccounts(), meta(outflightFlowPda)],
      })).rejects.toThrow(/SwapAccountNotAllowed/)
    })
  })

  describe('step 2 — direct + cross-program custody ATAs', () => {
    it('2a rejects an off-protocol classic-SPL account owned by relayer_authority', async () => {
      const otherMint = createMint(svm, authority, 6)
      const rogue = Keypair.generate().publicKey
      createTokenAccount(svm, rogue, otherMint.publicKey, relayerAuthorityPda, 1_000n)

      await expect(runSwap({
        swapProgram: PublicKey.default,
        swapIxData: ixData(0, netOnyc, outUsdc),
        swapAccounts: [...honestAccounts(), meta(rogue)],
      })).rejects.toThrow(/SwapAccountNotAllowed/)
    })

    it('2b rejects a Token-2022 account owned by relayer_authority', async () => {
      // A single-`token_program` gate misses this; `InterfaceAccount::
      // <TokenAccount>::try_from` decodes both, so the exclusion still fires.
      const t22Mint = Keypair.generate().publicKey
      {
        const data = new Uint8Array(82)
        data[44] = 6 // decimals
        data[45] = 1 // is_initialized
        svm.setAccount(t22Mint, {
          executable: false,
          owner: TOKEN_2022_PROGRAM_ID,
          lamports: 1_461_600,
          data,
          rentEpoch: 0,
        })
      }
      const rogue22 = Keypair.generate().publicKey
      {
        const data = new Uint8Array(165)
        data.set(t22Mint.toBytes(), 0)
        data.set(relayerAuthorityPda.toBytes(), 32)
        new DataView(data.buffer).setBigUint64(64, 1_000n, true) // amount
        data[108] = 1 // state: initialized
        svm.setAccount(rogue22, {
          executable: false,
          owner: TOKEN_2022_PROGRAM_ID,
          lamports: 2_039_280,
          data,
          rentEpoch: 0,
        })
      }

      await expect(runSwap({
        swapProgram: PublicKey.default,
        swapIxData: ixData(0, netOnyc, outUsdc),
        swapAccounts: [...honestAccounts(), meta(rogue22)],
      })).rejects.toThrow(/SwapAccountNotAllowed/)
    })

    it('2c reverts a router that drains relayer_authority lamports', async () => {
      // relayer_authority is passed THROUGH writable (OnRe needs it `mut`); the
      // handler snapshots lamports/owner/data and re-checks post-CPI to revert.
      const accounts = honestAccounts()
      accounts[4] = meta(relayerAuthorityPda, true)
      accounts[5] = meta(poolAuthority, true) // drain destination must be writable
      accounts.push(meta(PublicKey.default, false)) // system_program at index 7

      await expect(runSwap({
        swapProgram: ROUTER_ID,
        swapIxData: ixData(3, netOnyc, outUsdc),
        swapAccounts: accounts,
      })).rejects.toThrow(/RelayerAuthorityTampered/)
    })
  })

  describe('step 3 — exact-consume guard', () => {
    it('rejects over-consume (in = net + 1)', async () => {
      await expect(runSwap({
        swapProgram: ROUTER_ID,
        swapIxData: ixData(0, netOnyc + 1n, outUsdc),
        swapAccounts: honestAccounts(),
      })).rejects.toThrow(/InputConsumedMismatch/)
    })

    it('rejects under-consume (in = net - 1)', async () => {
      await expect(runSwap({
        swapProgram: ROUTER_ID,
        swapIxData: ixData(0, netOnyc - 1n, outUsdc),
        swapAccounts: honestAccounts(),
      })).rejects.toThrow(/InputConsumedMismatch/)
    })
  })

  describe('step 4 — signed-floor guard', () => {
    it('rejects output below flow.min_swap_out (out = 1)', async () => {
      await expect(runSwap({
        swapProgram: ROUTER_ID,
        swapIxData: ixData(0, netOnyc, 1n),
        swapAccounts: honestAccounts(),
      })).rejects.toThrow(/OutputBelowFloor/)
    })
  })

  describe('step 5 — ATA-tamper guard', () => {
    it('rejects a lingering SPL delegate left on asset_ata (mode 1)', async () => {
      await expect(runSwap({
        swapProgram: ROUTER_ID,
        swapIxData: ixData(1, netOnyc, outUsdc),
        swapAccounts: honestAccounts(),
      })).rejects.toThrow(/AtaAuthorityTampered/)
    })

    it('rejects a close_authority set on asset_ata (mode 2)', async () => {
      await expect(runSwap({
        swapProgram: ROUTER_ID,
        swapIxData: ixData(2, netOnyc, outUsdc),
        swapAccounts: honestAccounts(),
      })).rejects.toThrow(/AtaAuthorityTampered/)
    })

    it('clears a pre-existing delegate and lets the honest swap proceed', async () => {
      // Regression for the AtaAuthorityTampered DoS: a stale delegate planted
      // before the handler runs (residue from old bytecode) must be revoked
      // pre-CPI, not block the flow. The honest mode-0 swap then succeeds and
      // leaves the ATA pristine.
      const data = new Uint8Array(165)
      data.set(assetMint.publicKey.toBytes(), 0)
      data.set(relayerAuthorityPda.toBytes(), 32)
      const view = new DataView(data.buffer)
      view.setBigUint64(64, grossOnyc + 10n, true) // amount
      view.setUint32(72, 1, true) // delegate COption tag = Some
      data.set(Keypair.generate().publicKey.toBytes(), 76) // stale delegate
      data[108] = 1 // state = Initialized
      view.setBigUint64(121, grossOnyc, true) // delegated_amount
      svm.setAccount(assetAta, {
        executable: false,
        owner: TOKEN_PROGRAM_ID,
        lamports: 2_039_280,
        data,
        rentEpoch: 0,
      })

      await runSwap({
        swapProgram: ROUTER_ID,
        swapIxData: ixData(0, netOnyc, outUsdc),
        swapAccounts: honestAccounts(),
      })

      const after = svm.getAccount(assetAta)!
      expect(new DataView(new Uint8Array(after.data).buffer).getUint32(72, true)).toBe(0)
    })
  })

  describe('step 6 — configure cannot rotate config mints', () => {
    it('leaves base/asset mints pinned across a benign configure', async () => {
      const before = await client.fetchConfig()
      await (await client.configure({ depositFeeBps: 5 })).rpc()
      const after = await client.fetchConfig()
      expect(after.baseMint).toEqual(before.baseMint)
      expect(after.assetMint).toEqual(before.assetMint)
    })
  })
})
