/**
 * Step 2 of either chain: route-agnostic swap. Deposit swaps base→asset
 * via OnRe `take_offer`; withdraw swaps asset→base via any router (Jupiter
 * today). Both advance the Flow `Received → Swapped`. Merges the old
 * `swapUsdcToOnyc` and `swapOnycToUsdc` handlers, branching on
 * `input.direction`.
 *
 * The on-chain `swap` handler enforces a single output floor — the
 * user-signed `flow.min_swap_out` (no protocol-invented NAV band). The
 * cranker pre-checks the chosen venue's expected output against that floor
 * and noops rather than submitting a guaranteed on-chain revert.
 */
import type { AdvanceContext, AdvanceResult } from './types'
import {
  buildOnreSwapRemainingAccounts,
  calculateStepPrice,
  DEFAULT_SLIPPAGE_TOLERANCE_BPS,
  depositExpectedOut,
  describeStatus,
  fetchJupiterRoute,
  findAuthorityPda,
  findInflightFlowPda,
  findOnreOfferPda,
  findOutflightFlowPda,
  ONRE_PROGRAM_ID,
  parseActiveOfferVector,
  resolveNttVaa,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { makePriorityFeeIx } from '../utils/priority-fee'
import { withTimeout } from '../utils/rpc'
import { fetchVaaBytes } from '../utils/wormhole'
import { fetchFlowFor } from './flow-fetch'
import { isLostRace } from './race-classifier'

// OnRe `take_offer_one` discriminator (anchor sighash).
const TAKE_OFFER_DISCRIMINATOR = Buffer.from([37, 190, 224, 77, 197, 39, 203, 230])

const SPL_MINT_DECIMALS_OFFSET = 44
const SPL_MINT_MIN_LEN = 82

function readMintDecimals(data: Uint8Array | Buffer | null | undefined): number | null {
  if (!data || data.length < SPL_MINT_MIN_LEN) {
    return null
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array)
  return buf.readUInt8(SPL_MINT_DECIMALS_OFFSET)
}

function toUint8(data: Uint8Array | Buffer): Uint8Array {
  return data instanceof Uint8Array ? data : Uint8Array.from(data as unknown as ArrayLike<number>)
}

export type SwapInput = {
  direction: 'deposit' | 'withdraw'
  fogoTx: string
  vaaHex?: string
  nttProgram?: PublicKey
}

export async function swap(
  ctx: AdvanceContext,
  input: SwapInput,
): Promise<AdvanceResult> {
  const { connection, client, metrics } = ctx
  const isDeposit = input.direction === 'deposit'

  try {
    // Fetch the pair config first: the inbound NTT manager (used only to
    // resolve the VAA → inbox-item here) comes from it, not constants.
    const cfg = await client.fetchConfig()
    const nttProgram = input.nttProgram
      ?? (isDeposit ? (cfg.nttBaseProgram as PublicKey) : (cfg.nttAssetProgram as PublicKey))

    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

    const flow = await fetchFlowFor(client, input.direction, resolved.nttInboxItem)
    if (!flow) {
      return {
        kind: 'noop',
        reason: `no Flow for inbox-item ${resolved.nttInboxItem.toBase58()} — receive hasn't run`,
      }
    }
    const flowStatus = describeStatus(flow.status)
    if (flowStatus !== 'Received') {
      return {
        kind: 'noop',
        reason: `Flow status is ${flowStatus}, expected Received (already past this leg or in unexpected state)`,
      }
    }

    const baseMint = cfg.baseMint as PublicKey
    const assetMint = cfg.assetMint as PublicKey
    const feeVault = cfg.feeVault as PublicKey
    const [onreOffer] = findOnreOfferPda(baseMint, assetMint)
    const [relayerAuthorityPda] = findAuthorityPda(client.program.programId)

    // User-signed floor (output-token atomic units). The on-chain `swap`
    // enforces `out_received >= floor` against the GROSS swap output for both
    // legs (deposit fee is taken from output AFTER the check; withdraw fee
    // from the input BEFORE the swap), so the cranker checks the same gross.
    const floor = BigInt(flow.minSwapOut.toString())
    const grossIn = BigInt(flow.amount.toString())
    if (grossIn <= 0n) {
      return { kind: 'noop', reason: 'flow.amount is zero' }
    }

    if (isDeposit) {
      const [offerInfo, baseMintInfo, assetMintInfo] = await withTimeout(
        Promise.all([
          connection.getAccountInfo(onreOffer),
          connection.getAccountInfo(baseMint),
          connection.getAccountInfo(assetMint),
        ]),
        ctx.rpcTimeoutMs,
        'swap.getAccountInfo(offer+mints)',
      )
      if (!offerInfo) {
        return {
          kind: 'error',
          error: new Error(`OnRe deposit Offer PDA ${onreOffer.toBase58()} not found`),
          partialSignatures: [],
        }
      }
      const usdcDecimals = readMintDecimals(baseMintInfo?.data)
      const onycDecimals = readMintDecimals(assetMintInfo?.data)
      if (usdcDecimals === null || onycDecimals === null) {
        return { kind: 'error', error: new Error('mint decimals unreadable'), partialSignatures: [] }
      }
      const offerData = toUint8(offerInfo.data)
      const nowUnix = BigInt(Math.floor(Date.now() / 1000))
      const price = calculateStepPrice(parseActiveOfferVector(offerData, nowUnix), nowUnix)
      const expectedOnyc = depositExpectedOut(grossIn, price, usdcDecimals, onycDecimals)
      if (expectedOnyc < floor) {
        return {
          kind: 'noop',
          reason: `OnRe take_offer output ${expectedOnyc} below user floor min_swap_out ${floor}`,
        }
      }

      const [flowPda] = findInflightFlowPda(client.configPda, resolved.nttInboxItem, client.program.programId)
      const amountIn = Buffer.alloc(8)
      amountIn.writeBigUInt64LE(grossIn)
      const swapIxData = Buffer.concat([TAKE_OFFER_DISCRIMINATOR, amountIn, Buffer.from([0])])
      const swapAccounts = buildOnreSwapRemainingAccounts({
        tokenInMint: baseMint,
        tokenOutMint: assetMint,
        userTokenInAccount: getAssociatedTokenAddressSync(baseMint, relayerAuthorityPda, true),
        userTokenOutAccount: getAssociatedTokenAddressSync(assetMint, relayerAuthorityPda, true),
        user: relayerAuthorityPda,
      })

      const sig = await client
        .swap({
          flowPda,
          baseMint,
          assetMint,
          feeVault,
          nttInboxItem: resolved.nttInboxItem,
          swapProgram: ONRE_PROGRAM_ID,
          swapDelegate: relayerAuthorityPda,
          swapIxData,
          swapAccounts,
        })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          makePriorityFeeIx(ctx.priorityFeeMicroLamports),
        ])
        .rpc()

      metrics.txSent.inc({ instruction: 'swap', result: 'ok' })
      metrics.flowAdvance.inc({ leg: input.direction, from_status: 'Received', to_status: 'Swapped' })
      return { kind: 'advanced', signatures: [sig], fromStatus: 'Received', toStatus: 'Swapped' }
    }

    // Withdraw: ONyc → USDC via the configured router, gated by the
    // user-signed floor (no on-chain submit unless the quote clears it). The
    // withdraw fee is asset-denominated and taken from the INPUT on-chain, so
    // the router swaps the net ONyc and its output must clear `floor`.
    const withdrawFeeBps = BigInt(cfg.withdrawFeeBps)
    const feeOnyc = (grossIn * withdrawFeeBps) / 10_000n
    const netOnyc = grossIn - feeOnyc
    if (netOnyc <= 0n) {
      return { kind: 'noop', reason: 'fee consumed entire amount — config error' }
    }

    // Jupiter routing slippage tolerance (a router param) — distinct from the
    // protocol floor, which is the user-signed `flow.min_swap_out` checked below.
    const route = await withTimeout(
      fetchJupiterRoute({
        inputMint: assetMint,
        outputMint: baseMint,
        amount: netOnyc,
        slippageBps: DEFAULT_SLIPPAGE_TOLERANCE_BPS,
        userPublicKey: relayerAuthorityPda,
      }),
      ctx.rpcTimeoutMs,
      'swap.fetchJupiterRoute',
    )
    if (route.quotedOutAmount < floor) {
      return {
        kind: 'noop',
        reason: `Jupiter quote ${route.quotedOutAmount} below user floor min_swap_out ${floor}`,
      }
    }

    // `shared_accounts_route` pulls the input via the `userTransferAuthority`
    // owner-signature (= relayer_authority, signed by the handler's
    // invoke_signed), never via an SPL delegate. Passing the sentinel
    // (relayer_authority) skips the on-chain Approve, so no standing
    // delegation lingers to trip the post-CPI pristine-ATA guard
    // (AtaAuthorityTampered). Mirrors the deposit/take_offer path above.
    const [flowPda] = findOutflightFlowPda(client.configPda, resolved.nttInboxItem, client.program.programId)
    const swapIx = await client
      .swap({
        flowPda,
        baseMint,
        assetMint,
        feeVault,
        nttInboxItem: resolved.nttInboxItem,
        swapProgram: route.programId,
        swapDelegate: relayerAuthorityPda,
        swapIxData: route.ixData,
        swapAccounts: route.routeAccounts,
      })
      .instruction()

    // Jupiter `shared_accounts_route` + Approve/NTT blows the legacy tx
    // limit; route ships ALTs for the v0 path.
    const altAccounts = await withTimeout(
      Promise.all(
        route.addressLookupTables.map(async (key) => {
          const res = await connection.getAddressLookupTable(key)
          if (!res.value) {
            throw new Error(`AddressLookupTable ${key.toBase58()} not found`)
          }
          return res.value
        }),
      ),
      ctx.rpcTimeoutMs,
      'swap.getAddressLookupTable',
    )

    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const messageV0 = new TransactionMessage({
      payerKey: ctx.provider.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
        makePriorityFeeIx(ctx.priorityFeeMicroLamports),
        swapIx,
      ],
    }).compileToV0Message(altAccounts)
    const vtx = new VersionedTransaction(messageV0)
    const sig = await ctx.provider.sendAndConfirm(vtx, [], {
      commitment: 'confirmed',
      skipPreflight: false,
    })

    metrics.txSent.inc({ instruction: 'swap', result: 'ok' })
    metrics.flowAdvance.inc({ leg: input.direction, from_status: 'Received', to_status: 'Swapped' })
    return { kind: 'advanced', signatures: [sig], fromStatus: 'Received', toStatus: 'Swapped' }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'swap', result: 'error' })
    const raceReason = isLostRace(err)
    if (raceReason) {
      return { kind: 'noop', reason: raceReason }
    }
    return {
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      partialSignatures: [],
    }
  }
}
