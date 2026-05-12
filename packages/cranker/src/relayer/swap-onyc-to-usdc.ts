/**
 * Withdraw step 2: permissionless ONyc → USDC swap via any router
 * (Jupiter today; aggregator-agnostic by design).
 *
 * Flow:
 *   1. Resolve outflight Flow; require status == Claimed (synthetic
 *      `WithdrawClaimed`).
 *   2. Compute net_onyc = flow.amount * (10_000 - withdraw_fee_bps) / 10_000
 *      to mirror the on-chain fee deduction. Quote Jupiter for net_onyc
 *      against the relayer authority PDA.
 *   3. Compose against the on-chain NAV floor via `quoteRedeemOnycRecovery`.
 *      If quote < floor, noop with reason — operator triages liquidity;
 *      no on-chain submit, no fee burn.
 *   4. If quote clears, submit `client.swapOnycToUsdc(...)` with the
 *      Jupiter route data + accounts. The on-chain handler re-validates
 *      the floor after the swap; this preview is purely defensive against
 *      sending a tx the chain will reject.
 *
 * Stateless aside from the per-flow `Flow` PDA. `swap_delegate` is
 * Jupiter's `programAuthority` — pulled from the route response so the
 * on-chain Approve targets the right PDA.
 */
import type { AdvanceContext, AdvanceResult } from './types'
import {
  applySlippageFloor,
  calculateStepPrice,
  describeStatus,
  fetchJupiterRoute,
  findAuthorityPda,
  findOnreOfferPda,
  MAX_SLIPPAGE_BPS,
  NTT_ONYC_PROGRAM_ID,
  parseActiveOfferVector,
  redemptionExpectedOut,
  resolveNttVaa,
} from '@fogo-onre/sdk'
import { ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { makePriorityFeeIx } from '../utils/priority-fee'
import { withTimeout } from '../utils/rpc'
import { fetchVaaBytes } from '../utils/wormhole'
import { isLostRace } from './race-classifier'

const SPL_MINT_DECIMALS_OFFSET = 44
const SPL_MINT_MIN_LEN = 82

function readMintDecimals(data: Uint8Array | Buffer | null | undefined): number | null {
  if (!data || data.length < SPL_MINT_MIN_LEN) {
    return null
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array)
  return buf.readUInt8(SPL_MINT_DECIMALS_OFFSET)
}

export type SwapOnycToUsdcInput = {
  fogoTx: string
  vaaHex?: string
  nttProgram?: PublicKey
}

export async function swapOnycToUsdc(
  ctx: AdvanceContext,
  input: SwapOnycToUsdcInput,
): Promise<AdvanceResult> {
  const { connection, client, metrics } = ctx
  const nttProgram = input.nttProgram ?? NTT_ONYC_PROGRAM_ID

  try {
    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

    // Pre-flight 1: outflight Flow exists, status Claimed.
    const flow = await client.fetchOutflightFlow(resolved.nttInboxItem).catch(() => null)
    if (!flow) {
      return {
        kind: 'noop',
        reason: `no outflight Flow for inbox-item ${resolved.nttInboxItem.toBase58()} — unlock_onyc hasn't landed yet`,
      }
    }
    const flowStatus = describeStatus(flow.status)
    if (flowStatus !== 'Claimed') {
      return {
        kind: 'noop',
        reason: `outflight Flow status is ${flowStatus}, expected Claimed (synthetic: WithdrawClaimed)`,
      }
    }

    // Pre-flight 2: config + mints + fee.
    const cfg = await client.fetchConfig()
    const usdcMint = cfg.usdcMint as PublicKey
    const onycMint = cfg.onycMint as PublicKey
    const feeVault = cfg.feeVault as PublicKey
    const withdrawFeeBps = BigInt(cfg.withdrawFeeBps)

    const grossOnyc = BigInt(flow.amount.toString())
    if (grossOnyc <= 0n) {
      return { kind: 'noop', reason: 'flow.amount is zero' }
    }
    // Mirror Rust `apply_fee_bps`: fee = floor(gross * bps / 10_000),
    // net  = gross - fee. Saturating at u64 is unnecessary here — the
    // chain will revert if the math diverges, and we've already capped
    // bps at MAX_FEE_BPS via on-chain `configure`.
    const feeOnyc = (grossOnyc * withdrawFeeBps) / 10_000n
    const netOnyc = grossOnyc - feeOnyc
    if (netOnyc <= 0n) {
      return { kind: 'noop', reason: 'fee consumed entire amount — config error' }
    }

    // Pre-flight 3: NAV floor + Jupiter route. Same shape as the
    // recovery quoter, only the input amount changes (net of fee).
    const [offerPda] = findOnreOfferPda(usdcMint, onycMint)
    const [offerInfo, usdcMintInfo, onycMintInfo] = await withTimeout(
      Promise.all([
        connection.getAccountInfo(offerPda),
        connection.getAccountInfo(usdcMint),
        connection.getAccountInfo(onycMint),
      ]),
      ctx.rpcTimeoutMs,
      'swapOnycToUsdc.getAccountInfo(offer+mints)',
    )
    if (!offerInfo) {
      return {
        kind: 'error',
        error: new Error(`OnRe deposit Offer PDA ${offerPda.toBase58()} not found`),
        partialSignatures: [],
      }
    }
    const usdcDecimals = readMintDecimals(usdcMintInfo?.data)
    const onycDecimals = readMintDecimals(onycMintInfo?.data)
    if (usdcDecimals === null || onycDecimals === null) {
      return {
        kind: 'error',
        error: new Error('mint decimals unreadable'),
        partialSignatures: [],
      }
    }
    const offerData = offerInfo.data instanceof Uint8Array
      ? offerInfo.data
      : Uint8Array.from(offerInfo.data as unknown as ArrayLike<number>)
    const nowUnix = BigInt(Math.floor(Date.now() / 1000))
    const active = parseActiveOfferVector(offerData, nowUnix)
    const price = calculateStepPrice(active, nowUnix)
    const grossExpected = redemptionExpectedOut(netOnyc, price, onycDecimals, usdcDecimals)
    const navFloor = applySlippageFloor(grossExpected, MAX_SLIPPAGE_BPS)

    const [relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    const route = await withTimeout(
      fetchJupiterRoute({
        inputMint: onycMint,
        outputMint: usdcMint,
        amount: netOnyc,
        slippageBps: MAX_SLIPPAGE_BPS,
        userPublicKey: relayerAuthorityPda,
      }),
      ctx.rpcTimeoutMs,
      'swapOnycToUsdc.fetchJupiterRoute',
    )

    if (route.quotedOutAmount < navFloor) {
      return {
        kind: 'noop',
        reason: `Jupiter quote ${route.quotedOutAmount} below NAV floor ${navFloor} (gross ${grossExpected})`,
      }
    }
    if (!route.swapDelegate) {
      return {
        kind: 'noop',
        reason: 'Jupiter route did not surface a swap_delegate (programAuthority); cannot bound on-chain Approve safely',
      }
    }

    const sig = await (async () => {
      // Jupiter `shared_accounts_route` + on-chain Approve/NTT release
      // blows the 1232-byte legacy tx limit; route ships ALTs for the
      // v0 path. Build instruction → compile v0 with ALTs → send through
      // the AnchorProvider (cranker authority is the only signer).
      const swapIx = await client
        .swapOnycToUsdc({
          onycMint,
          usdcMint,
          nttInboxItem: resolved.nttInboxItem,
          feeVault,
          onreOffer: offerPda,
          swapProgram: route.programId,
          swapDelegate: route.swapDelegate,
          swapIxData: route.ixData,
          swapAccounts: route.routeAccounts,
        })
        .instruction()

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
        'swapOnycToUsdc.getAddressLookupTable',
      )

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
      const payerKey = ctx.provider.wallet.publicKey
      const messageV0 = new TransactionMessage({
        payerKey,
        recentBlockhash: blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
          makePriorityFeeIx(ctx.priorityFeeMicroLamports),
          swapIx,
        ],
      }).compileToV0Message(altAccounts)
      const vtx = new VersionedTransaction(messageV0)

      const signature = await ctx.provider.sendAndConfirm(vtx, [], {
        commitment: 'confirmed',
        skipPreflight: false,
      })
      await withTimeout(
        connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          'confirmed',
        ),
        ctx.rpcTimeoutMs,
        'swapOnycToUsdc.confirmTransaction',
      )
      return signature
    })()

    metrics.txSent.inc({ instruction: 'swap_onyc_to_usdc', result: 'ok' })
    metrics.flowAdvance.inc({
      leg: 'withdraw',
      from_status: 'WithdrawClaimed',
      to_status: 'WithdrawSwapped',
    })

    return {
      kind: 'advanced',
      signatures: [sig],
      fromStatus: 'WithdrawClaimed',
      toStatus: 'WithdrawSwapped',
    }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'swap_onyc_to_usdc', result: 'error' })
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
