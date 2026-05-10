import type { AdvanceContext, AdvanceResult } from './types'
import {
  describeStatus,
  findNttPeerPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  resolveNttVaa,
} from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { withTimeout } from '../utils/rpc'
import { fetchVaaBytes } from '../utils/wormhole'
import { prepareTransceiverMessage } from './prepare-transceiver-message'
import { isLostRace } from './race-classifier'

export type UnlockOnycInput = {
  fogoTx: string
  vaaHex?: string
  onycMint?: PublicKey
  nttProgram?: PublicKey
}

/**
 * Step 1 of the withdraw chain. Drives `unlock_onyc` on Solana: NTT
 * `redeem` + `release_inbound_unlock` for the FOGO ONyc burn VAA, plus
 * init of the **outflight** Flow PDA. Status: (no flow) → `Claimed`,
 * surfaced to the daemon as `WithdrawPending` → `WithdrawClaimed` (the
 * synthetic leg-prefixed strings from `enumerate.ts:synthesizeStatus`
 * — the on-chain enum is shared between deposit/withdraw, so dispatch
 * needs the prefix to disambiguate).
 *
 * Sender derivation (key difference from `claimUsdc`): the on-chain
 * handler parses `fogo_sender` from the VAA's
 * `ValidatedTransceiverMessage` payload directly. The cranker doesn't
 * need to recover the user wallet from the FOGO tx — VTM is a Solana
 * account, never expires, and is unforgeable. This sidesteps the
 * "FOGO RPC retention" failure mode that gates `claimUsdc` (where a
 * VAA whose source tx has aged out is unrecoverable).
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
      rpcTimeoutMs: ctx.rpcTimeoutMs,
      txConfirmTimeoutMs: ctx.rpcTimeoutMs,
      log: ctx.log,
    })
    if (prep.kind === 'error') {
      return {
        kind: 'error',
        error: prep.error,
        partialSignatures: [],
      }
    }

    const sig = await client
      .unlockOnyc({
        payer: keypair.publicKey,
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
