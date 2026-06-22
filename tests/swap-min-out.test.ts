/**
 * Swap-floor guarantee: the floor is the user-signed `flow.min_swap_out`,
 * not a protocol-invented NAV band. Exercised against the local deterministic
 * `evil_router` (honest mode 0) on BOTH legs:
 *   - withdraw (asset→base): floor denominated in base (USDC).
 *   - deposit  (base→asset): floor denominated in asset (ONyc).
 *
 * For each leg we prove `out_received < min_swap_out` reverts with
 * `OutputBelowFloor`, and `out_received >= min_swap_out` flips the flow to
 * Swapped. No `onre_offer`, no `price_oracle` — the oracle band is gone.
 */

import { BN } from '@anchor-lang/core'
import {
  findAuthorityPda,
  findInflightFlowPda,
  findOutflightFlowPda,
  RelayerClient,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, PublicKey } from '@solana/web3.js'
import { Clock, LiteSVM } from 'litesvm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createAta,
  createMint,
  createProvider,
  createSvm,
  createTokenAccount,
  expectError,
} from './utils'

const ROUTER_ID = new PublicKey('8uyMF1riG7YSjvPrJcd5VbRaDCnYeqWyPe6HzMevn4bT')
const POOL_AUTH_SEED = Buffer.from('pool_auth')

type Meta = { pubkey: PublicKey, isSigner: boolean, isWritable: boolean }
const meta = (pubkey: PublicKey, isWritable = true): Meta => ({ pubkey, isSigner: false, isWritable })

// honest router ix data: [mode][in_amount LE][out_amount LE]
function ixData(mode: number, inAmount: bigint, outAmount: bigint): Buffer {
  const d = Buffer.alloc(17)
  d.writeUInt8(mode, 0)
  d.writeBigUInt64LE(inAmount, 1)
  d.writeBigUInt64LE(outAmount, 9)
  return d
}

describe('swap floor = flow.min_swap_out (no oracle band)', () => {
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

  // The evil_router pulls from account[0] (signed by relayer_authority) and
  // pushes from pool[account 2] → account[1]. Withdraw pulls asset, pushes
  // base; deposit is the mirror (pull base, push asset) — same router, the
  // input/output ATAs just swap positions.
  const withdrawAccounts = (): Meta[] => [
    meta(assetAta),
    meta(baseAta),
    meta(poolAsset),
    meta(poolBase),
    meta(relayerAuthorityPda, false),
    meta(poolAuthority, false),
    meta(TOKEN_PROGRAM_ID, false),
  ]

  const depositAccounts = (): Meta[] => [
    meta(baseAta),
    meta(assetAta),
    meta(poolBase),
    meta(poolAsset),
    meta(relayerAuthorityPda, false),
    meta(poolAuthority, false),
    meta(TOKEN_PROGRAM_ID, false),
  ]

  const runSwap = (flowPda: PublicKey, nttInboxItem: PublicKey, swapIxData: Buffer, swapAccounts: Meta[]) =>
    client
      .swap({
        flowPda,
        baseMint: baseMint.publicKey,
        assetMint: assetMint.publicKey,
        feeVault,
        nttInboxItem,
        swapProgram: ROUTER_ID,
        swapDelegate: relayerAuthorityPda,
        swapIxData,
        swapAccounts,
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
        depositFeeBps: 0,
        withdrawFeeBps: 0,
      })
      .rpc()

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))

    assetAta = getAssociatedTokenAddressSync(assetMint.publicKey, relayerAuthorityPda, true)
    baseAta = getAssociatedTokenAddressSync(baseMint.publicKey, relayerAuthorityPda, true)
    poolAsset = getAssociatedTokenAddressSync(assetMint.publicKey, poolAuthority, true)
    poolBase = getAssociatedTokenAddressSync(baseMint.publicKey, poolAuthority, true)
  })

  // Seed an inflight/outflight Flow with a chosen min_swap_out.
  async function seedFlow(args: {
    direction: 'deposit' | 'withdraw'
    nttInboxItem: PublicKey
    amount: bigint
    minSwapOut: bigint
  }): Promise<PublicKey> {
    const [flowPda, flowBump] = args.direction === 'deposit'
      ? findInflightFlowPda(client.configPda, args.nttInboxItem, client.program.programId)
      : findOutflightFlowPda(client.configPda, args.nttInboxItem, client.program.programId)
    const flowData = await client.program.coder.accounts.encode('flow', {
      recipient: new PublicKey(new Uint8Array(32).fill(7)),
      status: { received: {} },
      amount: new BN(args.amount.toString()),
      payer: authority.publicKey,
      bump: flowBump,
      direction: args.direction === 'deposit' ? { deposit: {} } : { withdraw: {} },
      minSwapOut: new BN(args.minSwapOut.toString()),
      receivedSlot: new BN(0),
    })
    svm.setAccount(flowPda, {
      executable: false,
      owner: client.program.programId,
      lamports: 2_000_000,
      data: flowData,
      rentEpoch: 0,
    })
    return flowPda
  }

  describe('withdraw (asset→base), floor in USDC', () => {
    const grossOnyc = 500_000n
    const minUsdc = 5_000_000n

    function seedWithdraw(nttInboxItem: PublicKey): Promise<PublicKey> {
      createTokenAccount(svm, assetAta, assetMint.publicKey, relayerAuthorityPda, grossOnyc + 10n)
      createTokenAccount(svm, baseAta, baseMint.publicKey, relayerAuthorityPda, 0n)
      createTokenAccount(svm, poolAsset, assetMint.publicKey, poolAuthority, 0n)
      createTokenAccount(svm, poolBase, baseMint.publicKey, poolAuthority, minUsdc)
      return seedFlow({ direction: 'withdraw', nttInboxItem, amount: grossOnyc, minSwapOut: minUsdc })
    }

    it('reverts when out_received < min_swap_out', async () => {
      const nttInboxItem = Keypair.generate().publicKey
      const flowPda = await seedWithdraw(nttInboxItem)
      await expectError(
        () => runSwap(flowPda, nttInboxItem, ixData(0, grossOnyc, minUsdc - 1n), withdrawAccounts()),
        'OutputBelowFloor',
      )
    })

    it('passes when out_received >= min_swap_out', async () => {
      const nttInboxItem = Keypair.generate().publicKey
      const flowPda = await seedWithdraw(nttInboxItem)
      await runSwap(flowPda, nttInboxItem, ixData(0, grossOnyc, minUsdc), withdrawAccounts()) // exactly the floor

      const flow = await client.fetchFlow(flowPda)
      expect(flow.status).toEqual({ swapped: {} })
      expect(BigInt(flow.amount.toString())).toEqual(minUsdc)
    })
  })

  describe('deposit (base→asset), floor in ONyc', () => {
    const grossUsdc = 5_000_000n
    const minOnyc = 400_000n

    function seedDeposit(nttInboxItem: PublicKey): Promise<PublicKey> {
      createTokenAccount(svm, baseAta, baseMint.publicKey, relayerAuthorityPda, grossUsdc + 10n)
      createTokenAccount(svm, assetAta, assetMint.publicKey, relayerAuthorityPda, 0n)
      createTokenAccount(svm, poolBase, baseMint.publicKey, poolAuthority, 0n)
      createTokenAccount(svm, poolAsset, assetMint.publicKey, poolAuthority, minOnyc)
      return seedFlow({ direction: 'deposit', nttInboxItem, amount: grossUsdc, minSwapOut: minOnyc })
    }

    it('reverts when out_received < min_swap_out', async () => {
      const nttInboxItem = Keypair.generate().publicKey
      const flowPda = await seedDeposit(nttInboxItem)
      await expectError(
        () => runSwap(flowPda, nttInboxItem, ixData(0, grossUsdc, minOnyc - 1n), depositAccounts()),
        'OutputBelowFloor',
      )
    })

    it('passes when out_received >= min_swap_out', async () => {
      const nttInboxItem = Keypair.generate().publicKey
      const flowPda = await seedDeposit(nttInboxItem)
      // deposit fee is 0, so out must cover minOnyc exactly.
      await runSwap(flowPda, nttInboxItem, ixData(0, grossUsdc, minOnyc), depositAccounts())

      const flow = await client.fetchFlow(flowPda)
      expect(flow.status).toEqual({ swapped: {} })
    })
  })
})
