/**
 * E2E test for the withdraw-direction unified `swap` handler (asset→base).
 *
 * The withdraw chain's receive leg (`unlock_onyc`) is exercised elsewhere;
 * here we seed the outflight `Flow` directly (status=Received,
 * direction=Withdraw) and prove the swap leg end-to-end against a local,
 * deterministic test router (`evil_router`, honest mode 0) — Jupiter is
 * infeasible hermetically (no mainnet route fixtures).
 *
 * The handler skims the withdraw fee in ONyc to `fee_vault` BEFORE the swap,
 * swaps exactly `net_onyc`, requires the USDC out to clear the user-signed
 * `flow.min_swap_out`, and flips the flow to Swapped with
 * `amount = usdc_received`.
 */

import { BN } from '@anchor-lang/core'
import {
  computeMinSwapOut,
  findAuthorityPda,
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
  loadAndPatchOnreOffer,
} from './utils'

const ROUTER_ID = new PublicKey('8uyMF1riG7YSjvPrJcd5VbRaDCnYeqWyPe6HzMevn4bT')
const POOL_AUTH_SEED = Buffer.from('pool_auth')

describe('withdraw swap e2e (asset→base via local router)', () => {
  let svm: LiteSVM
  let authority: Keypair
  let client: RelayerClient
  let baseMint: Keypair
  let assetMint: Keypair
  let relayerAuthorityPda: PublicKey
  let feeVault: PublicKey
  let offerPda: PublicKey
  let poolAuthority: PublicKey

  const grossOnyc = 500_000n // 0.5 ONyc gross
  const withdrawFeeBps = 100 // 1%
  const feeOnyc = (grossOnyc * BigInt(withdrawFeeBps)) / 10_000n // 5_000
  const netOnyc = grossOnyc - feeOnyc // 495_000
  const outUsdc = 5_000_000n // 5 USDC — comfortably above the signed floor

  beforeEach(() => {
    svm = createSvm()
    // 1 hour into the OnRe pricing vector's active period.
    svm.setClock(new Clock(0n, 0n, 0n, 0n, 1_773_882_000n))

    authority = Keypair.generate()
    const provider = createProvider(svm, authority)

    baseMint = createMint(svm, authority, 6)
    assetMint = createMint(svm, authority, 6)
    client = new RelayerClient(provider as any, { baseMint: baseMint.publicKey, assetMint: assetMint.publicKey })

    ;[relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    ;[poolAuthority] = PublicKey.findProgramAddressSync([POOL_AUTH_SEED], ROUTER_ID)

    feeVault = createAta(svm, authority, assetMint.publicKey, authority.publicKey)
  })

  it('skims fee in ONyc, swaps net to USDC, flips flow to Swapped', async () => {
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

    offerPda = loadAndPatchOnreOffer(svm, baseMint.publicKey, assetMint.publicKey)

    // User-signed floor: USDC out for net ONyc at the offer's step price, with
    // a 1% tolerance. The realised `outUsdc` (5 USDC) clears it comfortably.
    const minSwapOut = computeMinSwapOut({
      direction: 'withdraw',
      postTrimInAmount: grossOnyc,
      offerData: svm.getAccount(offerPda)!.data,
      nowUnix: 1_773_882_000n,
      baseDecimals: 6,
      onycDecimals: 6,
      slippageBps: 100,
      withdrawFeeBps,
    })

    // Relayer ATAs: fund ONyc with the gross; USDC starts at zero.
    const assetAta = getAssociatedTokenAddressSync(assetMint.publicKey, relayerAuthorityPda, true)
    const baseAta = getAssociatedTokenAddressSync(baseMint.publicKey, relayerAuthorityPda, true)
    createTokenAccount(svm, assetAta, assetMint.publicKey, relayerAuthorityPda, grossOnyc)
    createTokenAccount(svm, baseAta, baseMint.publicKey, relayerAuthorityPda, 0n)

    // Router pools owned by its pool_authority PDA (NOT relayer_authority, else
    // the handler's custody-exclusion loop rejects them).
    const poolAsset = getAssociatedTokenAddressSync(assetMint.publicKey, poolAuthority, true)
    const poolBase = getAssociatedTokenAddressSync(baseMint.publicKey, poolAuthority, true)
    createTokenAccount(svm, poolAsset, assetMint.publicKey, poolAuthority, 0n)
    createTokenAccount(svm, poolBase, baseMint.publicKey, poolAuthority, outUsdc)

    // Seed the outflight Flow directly (no real NTT receive leg).
    const nttInboxItem = Keypair.generate().publicKey
    const [outflightFlowPda, flowBump] = findOutflightFlowPda(client.configPda, nttInboxItem, client.program.programId)
    const flowData = await client.program.coder.accounts.encode('flow', {
      recipient: new PublicKey(new Uint8Array(32).fill(7)),
      status: { received: {} },
      amount: new BN(grossOnyc.toString()),
      payer: authority.publicKey,
      bump: flowBump,
      direction: { withdraw: {} },
      minSwapOut: new BN(minSwapOut.toString()),
      receivedSlot: new BN(0),
    })
    svm.setAccount(outflightFlowPda, {
      executable: false,
      owner: client.program.programId,
      lamports: 2_000_000,
      data: flowData,
      rentEpoch: 0,
    })

    // Router ix data: [mode=0 HONEST][in=net_onyc][out=out_usdc].
    const swapIxData = Buffer.alloc(17)
    swapIxData.writeUInt8(0, 0)
    swapIxData.writeBigUInt64LE(netOnyc, 1)
    swapIxData.writeBigUInt64LE(outUsdc, 9)

    // Router account order — see evil_router/src/lib.rs.
    const swapAccounts = [
      { pubkey: assetAta, isSigner: false, isWritable: true },
      { pubkey: baseAta, isSigner: false, isWritable: true },
      { pubkey: poolAsset, isSigner: false, isWritable: true },
      { pubkey: poolBase, isSigner: false, isWritable: true },
      { pubkey: relayerAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: poolAuthority, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ]

    try {
      await client
        .swap({
          flowPda: outflightFlowPda,
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
    } catch (e: any) {
      console.log('SWAP ERROR:', e.message)
      if (e.logs) {
        console.log('SWAP LOGS:', e.logs)
      }
      throw e
    }

    const readBalance = (ata: PublicKey): bigint => {
      const acct = svm.getAccount(ata)!
      return new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(64, true)
    }

    expect(readBalance(feeVault)).toEqual(feeOnyc)
    expect(readBalance(assetAta)).toEqual(0n) // gross fully left (fee + net)
    expect(readBalance(baseAta)).toEqual(outUsdc)

    // The handler enforces the user-signed `flow.min_swap_out`; prove the
    // realised USDC cleared it (and that it was a non-trivial, positive floor).
    expect(minSwapOut).toBeGreaterThan(0n)
    expect(outUsdc >= minSwapOut).toBe(true)

    const flow = await client.fetchFlow(outflightFlowPda)
    expect(flow.status).toEqual({ swapped: {} })
    expect(BigInt(flow.amount.toString())).toEqual(outUsdc)
  })
})
