import type { AdvanceContext, AdvanceResult } from './types'
import {
  describeStatus,
  findAuthorityPda,
  findOnreRedemptionOfferPda,
  findOnreRedemptionRequestPda,
  NTT_ONYC_PROGRAM_ID,
  REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET,
  resolveNttVaa,
} from '@fogo-onre/sdk'
import { PublicKey, SystemProgram } from '@solana/web3.js'

// OnRe `create_redemption_request` does Anchor `init` on the
// `redemption_request` PDA, debiting rent (~2.39M lamports observed)
// from `relayer_authority` because the relayer signs the OnRe CPI under
// that PDA. Without this top-up the call fails with `Transfer:
// insufficient lamports … need 2394240` (custom program 0x1) on any
// flow where the prior unlock_onyc tx left relayer_authority near its
// post-debit floor (~1.59M = 3M topup − 1.41M inbox_item rent). 4.5M
// covers the OnRe rent + headroom for layout growth without bloating
// per-flow lamport burn. Mirror in cli/src/commands/cranker.ts.
const RELAYER_AUTH_TOPUP = 4_500_000n
import { withTimeout } from '../utils/rpc'
import { fetchVaaBytes } from '../utils/wormhole'
import { isLostRace } from './race-classifier'

export type RequestRedemptionOnycInput = {
  fogoTx: string
  vaaHex?: string
  nttProgram?: PublicKey
}

/**
 * Step 2 of the withdraw chain. Drives `request_redemption_onyc` on
 * Solana: applies the withdraw fee, transfers fee to `fee_vault`,
 * snapshots the relayer USDC ATA, CPIs OnRe `create_redemption_request`
 * (which inits a fresh `RedemptionRequest` account that the cranker
 * supplies as a signing keypair), and inits the **singleton**
 * `RedemptionTracker` PDA. Status: `Claimed` → `RedemptionPending`,
 * surfaced as `WithdrawClaimed` → `RedemptionPending`.
 *
 * Singleton mutex (the operationally interesting part):
 * `RedemptionTracker` lives at one fixed PDA per program (seed
 * `["redemption_tracker"]`). At most one withdraw flow can be
 * mid-redemption at any time. The on-chain `init` constraint enforces
 * this — concurrent dispatch produces `AccountAlreadyInUse` (system
 * program error 0) for losers. Pre-flight 3 surfaces the gate as a
 * noop so the FSM doesn't burn cooldown when the tracker is rightfully
 * held by another flow; the catch-side race classifier is the
 * insurance against the TOCTOU window between pre-flight and submit.
 *
 * Sender keypair: OnRe's `create_redemption_request` does an `init` on
 * the `redemption_request` account, which means the cranker generates
 * a fresh ephemeral keypair and passes it as a signer. The keypair
 * isn't persisted anywhere — its pubkey gets recorded on-chain in
 * `RedemptionTracker.redemption_request`, which is what the next leg
 * (`claimRedemptionUsdc`) reads to find the account again.
 */
export async function requestRedemptionOnyc(
  ctx: AdvanceContext,
  input: RequestRedemptionOnycInput,
): Promise<AdvanceResult> {
  const { connection, keypair, client, metrics } = ctx
  const nttProgram = input.nttProgram ?? NTT_ONYC_PROGRAM_ID

  try {
    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

    // Pre-flight 1: outflight Flow must exist with status=Claimed. If it
    // doesn't exist, `unlockOnyc` hasn't run yet (or rolled back); if
    // status is anything else, this leg already advanced or the flow is
    // ahead of us in the chain.
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

    // Pre-flight 2: RelayerConfig must exist + read mints/fee_vault.
    // Same shape as `lockOnyc`'s config-driven constants — no static
    // input needed for the addresses, the on-chain config is the truth.
    const cfg = await client.fetchConfig()
    const usdcMint = cfg.usdcMint as PublicKey
    const onycMint = cfg.onycMint as PublicKey
    const feeVault = cfg.feeVault as PublicKey

    // Pre-flight 3: singleton `RedemptionTracker` PDA must NOT exist.
    // This is the on-chain mutex — at most one withdraw flow is
    // mid-redemption at any time. If the tracker is held, another flow
    // is at status `RedemptionPending`; we noop and let the daemon
    // re-pick this flow on the next scan tick (there's no point sleeping
    // — the holder might land within seconds, freeing the tracker).
    //
    // The `client.redemptionTrackerPda` is cached at construction (see
    // `client.ts:48`) so this is a single RPC, not a derive-and-fetch.
    const trackerInfo = await withTimeout(
      connection.getAccountInfo(client.redemptionTrackerPda),
      ctx.rpcTimeoutMs,
      'getAccountInfo(RedemptionTracker)',
    ).catch(() => null)
    if (trackerInfo) {
      return {
        kind: 'noop',
        reason: `RedemptionTracker singleton ${client.redemptionTrackerPda.toBase58()} already held — another withdraw flow is mid-redemption`,
      }
    }

    // OnRe `create_redemption_request` does `init` on a PDA seeded by
    // `[redemption_request, redemption_offer, request_counter_LE_u64]`.
    // The PDA is derived from the LIVE counter on the offer (snapshotted
    // before the CPI fires; OnRe increments inside the handler). Read
    // the offer, extract the counter, derive the PDA. PDAs don't sign —
    // OnRe inits via seeds, the relayer's `payer` covers rent.
    const [redemptionOfferPda] = findOnreRedemptionOfferPda(onycMint, usdcMint)
    const offerInfo = await withTimeout(
      connection.getAccountInfo(redemptionOfferPda),
      ctx.rpcTimeoutMs,
      'getAccountInfo(OnreRedemptionOffer)',
    ).catch(() => null)
    if (!offerInfo) {
      return {
        kind: 'error',
        error: new Error(`OnRe RedemptionOffer not found at ${redemptionOfferPda.toBase58()}`),
        partialSignatures: [],
      }
    }
    const counter = offerInfo.data.readBigUInt64LE(REDEMPTION_OFFER_REQUEST_COUNTER_OFFSET)
    const [redemptionRequestPda] = findOnreRedemptionRequestPda(redemptionOfferPda, counter)

    // Lamport top-up: OnRe `create_redemption_request` does Anchor
    // `init` on `redemption_request` PDA via invoke_signed under
    // `relayer_authority`, debiting ~2.39M from that PDA. Coming out
    // of unlock_onyc the PDA holds ~1.59M (3M topup − 1.41M inbox_item
    // rent), which is short. Mirror the unlock_onyc / send_usdc_to_user
    // top-up pattern: read current balance, fund the gap only when
    // below threshold.
    const [relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    const relayerAuthInfo = await connection.getAccountInfo(relayerAuthorityPda).catch(() => null)
    const relayerCurrentLamports = BigInt(relayerAuthInfo?.lamports ?? 0)
    const fundIxs: ReturnType<typeof SystemProgram.transfer>[] = []
    if (relayerCurrentLamports < RELAYER_AUTH_TOPUP) {
      fundIxs.push(SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: relayerAuthorityPda,
        lamports: Number(RELAYER_AUTH_TOPUP - relayerCurrentLamports),
      }))
    }

    const sig = await client
      .requestRedemptionOnyc({
        payer: keypair.publicKey,
        usdcMint,
        onycMint,
        nttInboxItem: resolved.nttInboxItem,
        feeVault,
        // `onre:` triggers SDK-side
        // `buildOnreCreateRedemptionRequestRemainingAccounts` to assemble
        // OnRe's expected account list with the relayer authority PDA as
        // the redeemer (per on-chain handler L62). Using the default
        // OnRe deployment — override only if a future test rig points at
        // a non-mainnet OnRe.
        onre: {
          redemptionRequest: redemptionRequestPda,
        },
      })
      .preInstructions(fundIxs)
      .rpc()

    metrics.txSent.inc({ instruction: 'request_redemption_onyc', result: 'ok' })
    metrics.flowAdvance.inc({
      leg: 'withdraw',
      from_status: 'WithdrawClaimed',
      to_status: 'RedemptionPending',
    })

    return {
      kind: 'advanced',
      signatures: [sig],
      fromStatus: 'WithdrawClaimed',
      toStatus: 'RedemptionPending',
    }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'request_redemption_onyc', result: 'error' })
    // TOCTOU race: tracker was free at pre-flight but a competing crank
    // initialized it before our submit landed. Anchor surfaces this as
    // the system-program "account already in use" error. The race
    // classifier owns the catalog; downgrade to noop so the FSM doesn't
    // quarantine a flow that's actually fine — the holder will release
    // the tracker, and the daemon re-picks us next scan.
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
