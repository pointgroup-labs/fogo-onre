import type { AdvanceContext, AdvanceResult } from './types'
import {
  describeStatus,
  findAuthorityPda,
  findNttPeerPda,
  findUserInboxWithMinPda,
  FOGO_WORMHOLE_CHAIN_ID,
  recoverWalletAndMinOutCandidates,
  resolveNttVaa,
} from '@fogo-onre/sdk'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { makePriorityFeeIx } from '../utils/priority-fee'
import { withTimeout } from '../utils/rpc'
import { fetchVaaBytes } from '../utils/wormhole'
import { readNttInboxAmount, readSplTokenAmount } from './account-layouts'
import { fetchFlowFor } from './flow-fetch'
import { prepareTransceiverMessage } from './prepare-transceiver-message'
import { isLostRace } from './race-classifier'
import { flagDormantSetterReplay } from './replay-monitor'

// NTT `redeem` inits `inbox_item` via invoke_signed under
// relayer_authority, debiting rent (~1.4M). 3M leaves headroom.
const RELAYER_AUTH_TOPUP = 3_000_000n

export type ReceiveInput = {
  direction: 'deposit' | 'withdraw'
  fogoTx: string
  vaaHex?: string
  /** Override the recovered wallet; pair with `minSwapOut` to skip tx recovery. */
  userWallet?: PublicKey
  /** Override the memo-recovered floor; required when `userWallet` is passed. */
  minSwapOut?: bigint
  recvMint?: PublicKey
  nttProgram?: PublicKey
}

/**
 * Entry leg of either chain: NTT redeem + per-user inbox sweep + write the
 * Flow receipt PDA (inflight for deposit, outflight for withdraw). Merges
 * the old `claimUsdc` (deposit) and `unlockOnyc` (withdraw) handlers,
 * branching on `input.direction` for mint / NTT manager / transceiver.
 * Advances `Pending → Received`.
 */
export async function receive(
  ctx: AdvanceContext,
  input: ReceiveInput,
): Promise<AdvanceResult> {
  const { connection, keypair, client, metrics } = ctx
  const isDeposit = input.direction === 'deposit'

  try {
    // Pre-flight: PairConfig must exist (catastrophic if not). Fetched
    // first so the NTT manager comes from the pair config, not constants.
    const cfgInfo = await withTimeout(
      connection.getAccountInfo(client.configPda),
      ctx.rpcTimeoutMs,
      'getAccountInfo(PairConfig)',
    ).catch(() => null)
    if (!cfgInfo) {
      return {
        kind: 'error',
        error: new Error(`PairConfig not found at ${client.configPda.toBase58()}`),
        partialSignatures: [],
      }
    }
    const cfg = await client.fetchConfig()
    const nttBaseProgram = cfg.nttBaseProgram as PublicKey
    const nttAssetProgram = cfg.nttAssetProgram as PublicKey
    // receive pulls in the received token: deposit→base manager, withdraw→asset.
    const nttProgram = input.nttProgram ?? (isDeposit ? nttBaseProgram : nttAssetProgram)
    const recvMint = input.recvMint ?? ((isDeposit ? cfg.baseMint : cfg.assetMint) as PublicKey)

    // Withdraw needs a distinct asset manager; if it still aliases the base
    // manager (placeholder) the CPI cannot custody the asset token.
    if (!isDeposit && nttAssetProgram.equals(nttBaseProgram)) {
      return {
        kind: 'noop',
        reason: 'asset NTT manager not deployed (cfg.nttAssetProgram == cfg.nttBaseProgram placeholder)',
      }
    }

    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

    // Observational replay monitor: flags a VAA routed through the dormant
    // intent program. Does not gate — the on-chain allowlist decides.
    flagDormantSetterReplay({ senderOnSource: resolved.senderOnSource, leg: input.direction, metrics, log: ctx.log })

    // OnRe sets `recipient_address` to a per-user inbox PDA (off-curve); an
    // on-curve recipient is a direct user→user bridge, not ours to advance.
    if (PublicKey.isOnCurve(resolved.recipientOnSolana.toBytes())) {
      return {
        kind: 'noop',
        reason: `VAA recipient ${resolved.recipientOnSolana.toBase58()} is on-curve (raw wallet) — non-OnRe direct bridge, not claimable by relayer`,
      }
    }

    // Recover { userWallet, minSwapOut } from the FOGO tx (wallet = source-ATA
    // owner, floor = `onre:mso:<n>` memo) and check the
    // min-bearing inbox PDA derives the VAA recipient. The memo is UNTRUSTED:
    // a wrong/missing value derives the wrong recipient, so the check below —
    // and the on-chain `receive` re-derivation — reject it (no skim). Cached
    // per scan.
    function deriveInboxAuthority(wallet: PublicKey, minSwapOut: bigint): PublicKey {
      const [pda] = findUserInboxWithMinPda(wallet, minSwapOut, client.program.programId)
      return pda
    }
    let userWallet: PublicKey
    let minSwapOut: bigint
    if (input.userWallet !== undefined && input.minSwapOut !== undefined) {
      userWallet = input.userWallet
      minSwapOut = input.minSwapOut
    } else {
      const cached = ctx.userWalletCache.get(input.fogoTx)
      let matched = cached ?? null
      if (!matched) {
        const candidates = await withTimeout(
          recoverWalletAndMinOutCandidates(ctx.fogoConnection, input.fogoTx),
          ctx.rpcTimeoutMs,
          'recoverWalletAndMinOutCandidates',
        ).catch(() => [])
        // Pick the candidate whose inbox PDA derives the VAA recipient —
        // robust to extra/decoy memos or bridge ixs in the source tx.
        matched = candidates.find(c =>
          deriveInboxAuthority(c.userWallet, c.minSwapOut).equals(resolved.recipientOnSolana),
        ) ?? null
      }
      if (!matched) {
        return {
          kind: 'noop',
          reason: `no { wallet, min_swap_out } candidate from FOGO tx ${input.fogoTx} derives VAA recipient ${resolved.recipientOnSolana.toBase58()} — not an OnRe ${input.direction} (missing tx / absent or unparseable memo / mismatch)`,
        }
      }
      userWallet = matched.userWallet
      minSwapOut = matched.minSwapOut
      ctx.userWalletCache.set(input.fogoTx, matched)
    }

    // Refuse to crank if the Flow receipt already exists (someone else got
    // there first, or we already advanced this VAA).
    const existing = await fetchFlowFor(client, input.direction, resolved.nttInboxItem)
    if (existing) {
      return {
        kind: 'noop',
        reason: `Flow already exists for inbox-item ${resolved.nttInboxItem.toBase58()} (status=${describeStatus(existing.status)})`,
      }
    }

    // Withdraw-only: FOGO peer must be registered on the ONyc NTT manager,
    // else redeem wiring fails Anchor's constraint. Operator config → noop.
    if (!isDeposit) {
      const [fogoPeerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, nttProgram)
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
    }

    const [userInboxAuthority] = findUserInboxWithMinPda(userWallet, minSwapOut, client.program.programId)
    const userInboxAta = getAssociatedTokenAddressSync(recvMint, userInboxAuthority, true)

    if (isDeposit) {
      // Pre-empt a permanent on-chain InsufficientInboxBalance failure: a
      // prior claim partially landed leaving the ATA short of the inbox-item.
      const [inboxInfo, ataInfo] = await Promise.all([
        withTimeout(
          connection.getAccountInfo(resolved.nttInboxItem),
          ctx.rpcTimeoutMs,
          'getAccountInfo(NttInboxItem)',
        ).catch(() => null),
        withTimeout(
          connection.getAccountInfo(userInboxAta),
          ctx.rpcTimeoutMs,
          'getAccountInfo(userInboxAta)',
        ).catch(() => null),
      ])
      const inboxAmount = readNttInboxAmount(inboxInfo?.data)
      if (inboxAmount !== null) {
        const ataAmount = readSplTokenAmount(ataInfo?.data) ?? 0n
        if (ataAmount < inboxAmount) {
          return {
            kind: 'noop',
            reason: `inbox-item ${resolved.nttInboxItem.toBase58()} exists with amount=${inboxAmount} but user_inbox_ata ${userInboxAta.toBase58()} balance=${ataAmount} — on-chain receive would fail at amount check. Unrecoverable from cranker.`,
          }
        }
      }

      // Derived inbox-authority must equal the VAA recipient.
      if (!userInboxAuthority.equals(resolved.recipientOnSolana)) {
        return {
          kind: 'error',
          error: new Error(
            `derived inbox-authority PDA (${userInboxAuthority.toBase58()}) does not match VAA recipient (${resolved.recipientOnSolana.toBase58()})`,
          ),
          partialSignatures: [],
        }
      }
    }

    const ensureUserInboxAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      keypair.publicKey,
      userInboxAta,
      userInboxAuthority,
      recvMint,
    )

    // Idempotently ensure the NTT `transceiver_message` PDA exists, owned by
    // the inbound manager (handler reads it but can't create it).
    const prep = await prepareTransceiverMessage({
      connection,
      payer: keypair,
      vaaBytes,
      transceiverMessagePda: resolved.nttTransceiverMessage,
      manager: nttProgram,
      token: recvMint,
      transceiver: nttProgram,
      expectedOwner: nttProgram,
      rpcTimeoutMs: ctx.rpcTimeoutMs,
      txConfirmTimeoutMs: ctx.txConfirmTimeoutMs,
      priorityFeeMicroLamports: ctx.priorityFeeMicroLamports,
      log: ctx.log,
    })
    if (prep.kind === 'error') {
      return { kind: 'error', error: prep.error, partialSignatures: [] }
    }

    // Lamport top-up: NTT `redeem` inits `inbox_item` under
    // relayer_authority, debiting rent. Top up only when below threshold.
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
      .receive({
        payer: keypair.publicKey,
        direction: isDeposit ? { deposit: {} } : { withdraw: {} },
        userWallet,
        minSwapOut,
        recvMint,
        nttInboxItem: resolved.nttInboxItem,
        nttTransceiverMessage: resolved.nttTransceiverMessage,
        ntt: { transceiverAddress: nttProgram },
        // Route the SDK through the config's managers, not its OnRe defaults.
        nttBaseProgram: cfg.nttBaseProgram as PublicKey,
        nttAssetProgram: cfg.nttAssetProgram as PublicKey,
      })
      .preInstructions([makePriorityFeeIx(ctx.priorityFeeMicroLamports), ...fundIxs, ensureUserInboxAtaIx])
      .rpc()

    metrics.txSent.inc({ instruction: 'receive', result: 'ok' })
    metrics.flowAdvance.inc({ leg: input.direction, from_status: 'Pending', to_status: 'Received' })

    return {
      kind: 'advanced',
      signatures: [sig],
      fromStatus: 'Pending',
      toStatus: 'Received',
    }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'receive', result: 'error' })
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
