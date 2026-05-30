import type { AdvanceContext, AdvanceResult } from './types'
import {
  deriveUserWalletFromFogoTx,
  describeStatus,
  findAuthorityPda,
  findNttPeerPda,
  findUserInboxAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  resolveNttVaa,
  WH_TRANSCEIVER_ONYC_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { makePriorityFeeIx } from '../utils/priority-fee'
import { withTimeout } from '../utils/rpc'
import { fetchVaaBytes } from '../utils/wormhole'
import { prepareTransceiverMessage } from './prepare-transceiver-message'
import { isLostRace } from './race-classifier'
import { flagDormantSetterReplay } from './replay-monitor'

// NTT `redeem` inits `inbox_item` PDA via invoke_signed under
// `relayer_authority`, which means the PDA pays rent. Its current
// balance is just rent-exempt for its own account; topping up to 3M
// lamports leaves comfortable headroom for inbox_item rent
// (~1.4M observed) plus any future NTT layout growth.
// Same constant family as send-usdc-to-user.ts; keep in sync.
const RELAYER_AUTH_TOPUP = 3_000_000n

export type UnlockOnycInput = {
  fogoTx: string
  vaaHex?: string
  userWallet?: PublicKey
  onycMint?: PublicKey
  nttProgram?: PublicKey
}

/**
 * Step 1 of the withdraw chain. Drives `unlock_onyc` on Solana: NTT
 * `redeem` + `release_inbound_unlock` for the FOGO ONyc burn VAA, the
 * per-user inbox sweep, plus init of the **outflight** Flow PDA. Status:
 * (no flow) → `Claimed`, surfaced to the daemon as `WithdrawPending` →
 * `WithdrawClaimed` (the synthetic leg-prefixed strings from
 * `enumerate.ts:synthesizeStatus` — the on-chain enum is shared between
 * deposit/withdraw, so dispatch needs the prefix to disambiguate).
 *
 * Wallet recovery (hard mirror of `claimUsdc`): redeem now routes through
 * the OnRe `intent_transfer` fork, so the VTM `sender` is the setter PDA
 * (constant per program) and attribution rides on the NTT
 * `recipient_address` = per-user inbox PDA. Neither is invertible, so we
 * recover `userWallet` from the FOGO source tx's `bridge_ntt_tokens`
 * source-ATA owner and validate it derives the VAA recipient.
 *
 * Pre-flight noops (versus errors) are chosen so the daemon doesn't
 * burn cooldown when the gate is operational, not protocol:
 *   - ONyc NTT manager not deployed (placeholder alias) → noop, retry
 *     forever; flips automatically once constants land.
 *   - FOGO peer not registered on the ONyc NTT manager → noop. NTT
 *     peer config is operator-controlled; a missing peer is a deploy
 *     gate, not corruption.
 *   - outflight Flow PDA already exists → noop (another cranker won
 *     the race, or this VAA was already advanced in a prior tick).
 *   - FOGO tx beyond RPC history retention → noop (unrecoverable).
 */
export async function unlockOnyc(
  ctx: AdvanceContext,
  input: UnlockOnycInput,
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
    // The VAA's inbox-item PDA is derived under the ONyc NTT program
    // ID — same program that emitted the FOGO burn. Mixing in
    // NTT_USDC_PROGRAM_ID here would derive a different PDA and the
    // outflight Flow PDA seed (`["outflight", inbox_item]`) would not
    // match what the on-chain handler initializes.
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

    // Observational replay monitor: flags a VAA routed through the dormant
    // intent program. Does not gate — the on-chain allowlist decides.
    flagDormantSetterReplay({ senderOnSource: resolved.senderOnSource, leg: 'withdraw', metrics, log: ctx.log })

    // Pre-flight 0: the ONyc NTT manager *must* be a real deployment.
    // While NTT_ONYC_PROGRAM_ID still aliases NTT_USDC_PROGRAM_ID per
    // the placeholder guard in `constants.ts`, the USDC manager
    // doesn't custody ONyc — the CPI cannot succeed. Symmetric with
    // `lockOnyc`'s guard.
    if (NTT_ONYC_PROGRAM_ID.equals(NTT_USDC_PROGRAM_ID)) {
      return {
        kind: 'noop',
        reason: 'ONyc NTT manager not deployed (NTT_ONYC_PROGRAM_ID == NTT_USDC_PROGRAM_ID placeholder)',
      }
    }

    // Pre-flight 1: RelayerConfig must exist (catastrophic if not — a
    // misconfigured cluster, not a flow problem). Reads `onycMint`
    // from config so the handler doesn't need it as input.
    const cfgInfo = await withTimeout(
      connection.getAccountInfo(client.configPda),
      ctx.rpcTimeoutMs,
      'getAccountInfo(RelayerConfig)',
    ).catch(() => null)
    if (!cfgInfo) {
      return {
        kind: 'error',
        error: new Error(`RelayerConfig not found at ${client.configPda.toBase58()}`),
        partialSignatures: [],
      }
    }
    const cfg = await client.fetchConfig()
    const onycMint = input.onycMint ?? (cfg.onycMint as PublicKey)

    // The intent redeem sets `recipient_address` to the per-user inbox
    // PDA (off-curve). An on-curve recipient is a direct user→user
    // bridge, not ours to unlock. Symmetric with `claimUsdc`.
    if (PublicKey.isOnCurve(resolved.recipientOnSolana.toBytes())) {
      return {
        kind: 'noop',
        reason: `VAA recipient ${resolved.recipientOnSolana.toBase58()} is on-curve (raw wallet) — non-OnRe direct bridge, not unlockable by relayer`,
      }
    }

    // Recover userWallet from the FOGO source tx and validate it derives
    // the VAA recipient. Cached across scans.
    function deriveInboxAuthority(wallet: PublicKey): PublicKey {
      const [pda] = findUserInboxAuthorityPda(wallet, client.program.programId)
      return pda
    }
    let userWallet: PublicKey
    if (input.userWallet) {
      userWallet = input.userWallet
    } else {
      const cached = ctx.userWalletCache.get(input.fogoTx)
      const recovered = cached
        ?? await withTimeout(
          deriveUserWalletFromFogoTx(ctx.fogoConnection, input.fogoTx),
          ctx.rpcTimeoutMs,
          'deriveUserWalletFromFogoTx',
        ).catch(() => null)
      if (!recovered) {
        return {
          kind: 'noop',
          reason: `FOGO tx ${input.fogoTx} not found — likely beyond RPC history retention; VAA recipient ${resolved.recipientOnSolana.toBase58()}`,
        }
      }
      if (!deriveInboxAuthority(recovered).equals(resolved.recipientOnSolana)) {
        return {
          kind: 'noop',
          reason: `recovered wallet ${recovered.toBase58()} from FOGO tx ${input.fogoTx} doesn't derive VAA recipient ${resolved.recipientOnSolana.toBase58()} — not an OnRe redeem`,
        }
      }
      userWallet = recovered
      ctx.userWalletCache.set(input.fogoTx, recovered)
    }

    // Pre-flight 2: outflight Flow PDA must NOT already exist. If it
    // does, either we (or another cranker) already submitted unlock for
    // this VAA — the next leg is `requestRedemptionOnyc`, not us.
    const existing = await client.fetchOutflightFlow(resolved.nttInboxItem).catch(() => null)
    if (existing) {
      return {
        kind: 'noop',
        reason: `outflight Flow already exists for inbox-item ${resolved.nttInboxItem.toBase58()} (status=${describeStatus(existing.status)})`,
      }
    }

    // Pre-flight 3: FOGO peer registered on the ONyc NTT manager.
    // Symmetric with `lockOnyc`. Without it the inbound NTT redeem
    // accounts wiring (`peer` PDA at IDL position N) would fail at
    // Anchor's account constraint check, never reaching the handler
    // body. Noop instead of error — operator-controlled config.
    const [fogoPeerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
    const peerInfo = await withTimeout(
      connection.getAccountInfo(fogoPeerPda),
      ctx.rpcTimeoutMs,
      'getAccountInfo(fogoPeer)',
    ).catch(() => null)
    if (!peerInfo) {
      return {
        kind: 'noop',
        reason: `FOGO peer not registered on ONyc NTT manager (${fogoPeerPda.toBase58()})`,
      }
    }

    // Per-user inbox ATA the NTT release lands in; the handler sweeps the
    // recorded amount into relayer custody. Created idempotently — FOGO
    // `bridge_ntt_tokens` with `pay_destination_ata_rent` usually
    // pre-creates it, but the cranker must not depend on that.
    const [userInboxAuthority] = findUserInboxAuthorityPda(userWallet, client.program.programId)
    const userInboxAta = getAssociatedTokenAddressSync(onycMint, userInboxAuthority, true)
    const ensureUserInboxAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      keypair.publicKey,
      userInboxAta,
      userInboxAuthority,
      onycMint,
    )

    // Pre-step: ensure ntt_transceiver_message PDA exists on Solana,
    // owned by the ONyc NTT manager. Wormhole's auto-relayer is not
    // subscribed to the ONyc manager (only USDC.s), so inbound VAAs
    // must be posted by us. The on-chain unlock_onyc handler declares
    // ntt_transceiver_message with `owner = NTT_ONYC_PROGRAM_ID` and
    // CANNOT create it (its CPI does redeem + release_inbound_unlock,
    // both of which read the existing transceiver_message). Skipping
    // this step yields ConstraintOwner (2004) at submit. Idempotent.
    const prep = await prepareTransceiverMessage({
      connection,
      payer: keypair,
      vaaBytes,
      transceiverMessagePda: resolved.nttTransceiverMessage,
      manager: NTT_ONYC_PROGRAM_ID,
      token: onycMint,
      transceiver: WH_TRANSCEIVER_ONYC_PROGRAM_ID,
      expectedOwner: NTT_ONYC_PROGRAM_ID,
      rpcTimeoutMs: ctx.rpcTimeoutMs,
      txConfirmTimeoutMs: ctx.txConfirmTimeoutMs,
      priorityFeeMicroLamports: ctx.priorityFeeMicroLamports,
      log: ctx.log,
    })
    if (prep.kind === 'error') {
      return {
        kind: 'error',
        error: prep.error,
        partialSignatures: [],
      }
    }

    // Lamport top-up: NTT `redeem` does `init` on `inbox_item` via
    // `invoke_signed` under `relayer_authority`, debiting rent from
    // that PDA. If relayer_authority is at its rent-exempt floor for
    // its own data, the inbox_item rent debit underflows
    // (`Transfer: insufficient lamports … need …`, custom error 0x1).
    // Top up to RELAYER_AUTH_TOPUP only when below threshold —
    // skipping the system_program transfer when not needed keeps the
    // tx small.
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
      .unlockOnyc({
        payer: keypair.publicKey,
        userWallet,
        onycMint,
        nttInboxItem: resolved.nttInboxItem,
        nttTransceiverMessage: resolved.nttTransceiverMessage,
        // `ntt: { transceiverAddress }` triggers SDK-side
        // `buildNttRedeemReleaseAccounts` — assembles redeem +
        // release_inbound_unlock account lists and computes
        // `redeem_accounts_len` automatically. Same plumbing the
        // deposit-side `claimUsdc` uses.
        ntt: { transceiverAddress: nttProgram },
      })
      .preInstructions([makePriorityFeeIx(ctx.priorityFeeMicroLamports), ...fundIxs, ensureUserInboxAtaIx])
      .rpc()

    metrics.txSent.inc({ instruction: 'unlock_onyc', result: 'ok' })
    metrics.flowAdvance.inc({
      leg: 'withdraw',
      from_status: 'WithdrawPending',
      to_status: 'WithdrawClaimed',
    })

    return {
      kind: 'advanced',
      signatures: [sig],
      fromStatus: 'WithdrawPending',
      toStatus: 'WithdrawClaimed',
    }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'unlock_onyc', result: 'error' })
    // Race: another cranker advanced unlock_onyc between our pre-flight
    // 2 and our submit. The race classifier owns the catalog of
    // "benign concurrent crank" Anchor codes — downgrade to noop so
    // the FSM doesn't quarantine a flow that's actually fine.
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
