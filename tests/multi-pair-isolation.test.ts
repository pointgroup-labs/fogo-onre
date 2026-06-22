/**
 * Multi-pair custody isolation: two independently-initialized pairs share the
 * global `relayer_authority` PDA (so the same signer owns both pairs' ATAs),
 * but a swap bound to pair B must consume exactly pair B's own input custody —
 * never pair A's resting balance.
 *
 * Two angles, both via the deterministic `evil_router`:
 *  - direct cross-drain: pair-B swap that lists pair-A's base ATA as the
 *    router's pull source reverts (pair-A custody is left untouched).
 *  - no-consume: pair-B swap whose router touches none of pair-B's input ATA
 *    trips the `in_consumed == swap_in` assert (`InputConsumedMismatch`).
 */

import { BN } from '@anchor-lang/core'
import {
  findAuthorityPda,
  findInflightFlowPda,
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
} from './utils'

const ROUTER_ID = new PublicKey('8uyMF1riG7YSjvPrJcd5VbRaDCnYeqWyPe6HzMevn4bT')
const POOL_AUTH_SEED = Buffer.from('pool_auth')

type Meta = { pubkey: PublicKey, isSigner: boolean, isWritable: boolean }
const meta = (pubkey: PublicKey, isWritable = true): Meta => ({ pubkey, isSigner: false, isWritable })

function ixData(mode: number, inAmount: bigint, outAmount: bigint): Buffer {
  const d = Buffer.alloc(17)
  d.writeUInt8(mode, 0)
  d.writeBigUInt64LE(inAmount, 1)
  d.writeBigUInt64LE(outAmount, 9)
  return d
}

describe('multi-pair custody isolation', () => {
  let svm: LiteSVM
  let authority: Keypair
  let relayerAuthorityPda: PublicKey
  let poolAuthority: PublicKey

  // Pair A (the resting victim) and pair B (the attacker's flow).
  let baseA: Keypair
  let assetA: Keypair
  let clientA: RelayerClient
  let feeVaultA: PublicKey
  let baseB: Keypair
  let assetB: Keypair
  let clientB: RelayerClient
  let feeVaultB: PublicKey

  // Pair A resting USDC custody the cross-drain would target.
  const restingUsdcA = 9_000_000n
  // Pair B deposit flow.
  const grossUsdcB = 5_000_000n
  const minOnycB = 400_000n

  beforeEach(async () => {
    svm = createSvm()
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

    authority = Keypair.generate()
    const provider = createProvider(svm, authority)
    ;[poolAuthority] = PublicKey.findProgramAddressSync([POOL_AUTH_SEED], ROUTER_ID)

    baseA = createMint(svm, authority, 6)
    assetA = createMint(svm, authority, 6)
    baseB = createMint(svm, authority, 6)
    assetB = createMint(svm, authority, 6)

    clientA = new RelayerClient(provider as any, { baseMint: baseA.publicKey, assetMint: assetA.publicKey })
    clientB = new RelayerClient(provider as any, { baseMint: baseB.publicKey, assetMint: assetB.publicKey })
    ;[relayerAuthorityPda] = findAuthorityPda(clientA.program.programId)

    feeVaultA = createAta(svm, authority, assetA.publicKey, authority.publicKey)
    feeVaultB = createAta(svm, authority, assetB.publicKey, authority.publicKey)

    await clientA.bootstrap({ admin: authority.publicKey }).rpc()
    await clientA
      .initialize({ authority: authority.publicKey, feeVault: feeVaultA, depositFeeBps: 0, withdrawFeeBps: 0 })
      .rpc()
    await clientB
      .initialize({ authority: authority.publicKey, feeVault: feeVaultB, depositFeeBps: 0, withdrawFeeBps: 0 })
      .rpc()

    svm.airdrop(relayerAuthorityPda, BigInt(5e9))
  })

  // Pair A's resting base (USDC) custody — the cross-drain target.
  function fundPairABase(): PublicKey {
    const baseAtaA = getAssociatedTokenAddressSync(baseA.publicKey, relayerAuthorityPda, true)
    createTokenAccount(svm, baseAtaA, baseA.publicKey, relayerAuthorityPda, restingUsdcA)
    return baseAtaA
  }

  // Seed a pair-B inflight (deposit) flow + pair-B operating ATAs + router pools.
  async function seedPairBDeposit(nttInboxItem: PublicKey): Promise<{
    flowPda: PublicKey
    baseAtaB: PublicKey
    assetAtaB: PublicKey
    poolBaseB: PublicKey
    poolAssetB: PublicKey
  }> {
    const baseAtaB = getAssociatedTokenAddressSync(baseB.publicKey, relayerAuthorityPda, true)
    const assetAtaB = getAssociatedTokenAddressSync(assetB.publicKey, relayerAuthorityPda, true)
    createTokenAccount(svm, baseAtaB, baseB.publicKey, relayerAuthorityPda, grossUsdcB + 10n)
    createTokenAccount(svm, assetAtaB, assetB.publicKey, relayerAuthorityPda, 0n)

    const poolBaseB = getAssociatedTokenAddressSync(baseB.publicKey, poolAuthority, true)
    const poolAssetB = getAssociatedTokenAddressSync(assetB.publicKey, poolAuthority, true)
    createTokenAccount(svm, poolBaseB, baseB.publicKey, poolAuthority, 0n)
    createTokenAccount(svm, poolAssetB, assetB.publicKey, poolAuthority, minOnycB)

    const [flowPda, flowBump] = findInflightFlowPda(clientB.configPda, nttInboxItem, clientB.program.programId)
    const flowData = await clientB.program.coder.accounts.encode('flow', {
      recipient: new PublicKey(new Uint8Array(32).fill(7)),
      status: { received: {} },
      amount: new BN(grossUsdcB.toString()),
      payer: authority.publicKey,
      bump: flowBump,
      direction: { deposit: {} },
      minSwapOut: new BN(minOnycB.toString()),
      receivedSlot: new BN(0),
    })
    svm.setAccount(flowPda, {
      executable: false,
      owner: clientB.program.programId,
      lamports: 2_000_000,
      data: flowData,
      rentEpoch: 0,
    })
    return { flowPda, baseAtaB, assetAtaB, poolBaseB, poolAssetB }
  }

  const runSwapB = (args: { flowPda: PublicKey, nttInboxItem: PublicKey, swapIxData: Buffer, swapAccounts: Meta[] }) =>
    clientB
      .swap({
        flowPda: args.flowPda,
        baseMint: baseB.publicKey,
        assetMint: assetB.publicKey,
        feeVault: feeVaultB,
        nttInboxItem: args.nttInboxItem,
        swapProgram: ROUTER_ID,
        swapDelegate: relayerAuthorityPda,
        swapIxData: args.swapIxData,
        swapAccounts: args.swapAccounts,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc()

  const readBalance = (ata: PublicKey): bigint => {
    const acct = svm.getAccount(ata)!
    return new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true)
  }

  it('reverts a pair-B swap that lists pair-A base custody as the router source', async () => {
    const baseAtaA = fundPairABase()
    const nttInboxItem = Keypair.generate().publicKey
    const { flowPda, assetAtaB, poolAssetB } = await seedPairBDeposit(nttInboxItem)

    // Router pull source = pair-A's USDC custody (the cross-drain), push to
    // pair-B's ONyc ATA from pair-B's pool. The handler's pre-CPI custody loop
    // rejects any relayer_authority-owned token account that is not pair-B's
    // own base/asset ATA.
    const crossDrainAccounts: Meta[] = [
      meta(baseAtaA), //          0 pull FROM — pair A's resting USDC
      meta(assetAtaB), //         1 push TO   — pair B's ONyc
      meta(poolAssetB), //        2 router ONyc pool (gets the pull)
      meta(poolAssetB), //        3 router pool (funds the push)
      meta(relayerAuthorityPda, false), // 4
      meta(poolAuthority, false), //       5
      meta(TOKEN_PROGRAM_ID, false), //    6
    ]

    await expect(
      runSwapB({ flowPda, nttInboxItem, swapIxData: ixData(0, grossUsdcB, minOnycB), swapAccounts: crossDrainAccounts }),
    ).rejects.toThrow(/SwapAccountNotAllowed/)

    // Pair A's resting custody is untouched.
    expect(readBalance(baseAtaA)).toEqual(restingUsdcA)
  })

  it('trips InputConsumedMismatch when a pair-B swap consumes none of its own input', async () => {
    fundPairABase()
    const nttInboxItem = Keypair.generate().publicKey
    const { flowPda, baseAtaB, assetAtaB, poolBaseB, poolAssetB } = await seedPairBDeposit(nttInboxItem)

    // Honest router accounts (pair-B's own ATAs only), but tell it to pull 0 of
    // pair-B's base while still producing ONyc output — so pair-B's input ATA
    // is untouched and `in_consumed (0) != swap_in (grossUsdcB)`.
    const depositAccounts: Meta[] = [
      meta(baseAtaB), //          0 pull FROM — pair B's USDC
      meta(assetAtaB), //         1 push TO   — pair B's ONyc
      meta(poolBaseB), //         2
      meta(poolAssetB), //        3
      meta(relayerAuthorityPda, false), // 4
      meta(poolAuthority, false), //       5
      meta(TOKEN_PROGRAM_ID, false), //    6
    ]

    await expect(
      runSwapB({ flowPda, nttInboxItem, swapIxData: ixData(0, 0n, minOnycB), swapAccounts: depositAccounts }),
    ).rejects.toThrow(/InputConsumedMismatch/)

    // Pair B's own input custody is intact too — nothing was consumed.
    expect(readBalance(baseAtaB)).toEqual(grossUsdcB + 10n)
  })
})
