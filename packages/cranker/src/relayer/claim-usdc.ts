import type { AdvanceContext, AdvanceResult } from './types'
import {
  deriveUserWalletFromFogoTx,
  describeStatus,
  findAuthorityPda,
  findUserInboxAuthorityPda,
  NTT_USDC_PROGRAM_ID,
  resolveNttVaa,
  USDC_MINT,
} from '@fogo-onre/sdk'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { makePriorityFeeIx } from '../utils/priority-fee'
import { withTimeout } from '../utils/rpc'
import { fetchVaaBytes } from '../utils/wormhole'
import { readNttInboxAmount, readSplTokenAmount } from './account-layouts'
import { prepareTransceiverMessage } from './prepare-transceiver-message'
import { isLostRace } from './race-classifier'

// NTT `Redeem` inits the `inbox_item` PDA via `invoke_signed` under the
// relayer-authority PDA, debiting rent (~1.41M lamports observed) from
// that PDA. If it's at the rent-exempt floor for its own data (~1.14M),
// the inner system_program::transfer underflows and the whole tx
// aborts with `Transfer: insufficient lamports … need …` (custom error
// 0x1 from System Program). 3M lamports leaves comfortable headroom for
// the rent debit plus any future NTT layout growth. Mirrors the
// matching constant in `unlock-onyc.ts` — keep them in sync.
const RELAYER_AUTH_TOPUP = 3_000_000n

export type ClaimUsdcInput = {
  fogoTx: string
  vaaHex?: string
  userWallet?: PublicKey
  usdcMint?: PublicKey
  nttProgram?: PublicKey
}

/**
 * Step 1 of the deposit chain. NTT redeem + per-user inbox sweep + write
 * the inflight Flow PDA. Ported from packages/cli/src/commands/cranker.ts:147-309.
 *
 * Cranker semantics differ from CLI:
 *  - No `--confirm` gate (always submits)
 *  - Pre-flight failures that the CLI would `throw` become `{ kind: 'noop' }`
 *    when they signal "someone else already advanced this leg", or
 *    `{ kind: 'error' }` when they're catastrophic (RelayerConfig missing, etc.)
 *  - All connection RPCs wrapped in `withTimeout`
 *  - Auto-detects userWallet: tries [signer, VAA-sender] in order
 */
export async function claimUsdc(
  ctx: AdvanceContext,
  input: ClaimUsdcInput,
): Promise<AdvanceResult> {
  const { connection, keypair, client, metrics } = ctx
  const usdcMint = input.usdcMint ?? USDC_MINT
  const nttProgram = input.nttProgram ?? NTT_USDC_PROGRAM_ID

  try {
    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

    // Pre-flight 0: skip non-OnRe deposits without an RPC. The OnRe
    // deposit path sets `recipient_address` to `findUserInboxAuthorityPda`
    // — a PDA, off-curve by construction. The off-the-shelf
    // `@fogo/sessions-sdk` `bridgeOut` (intent-transfer.ts:21) sets it to
    // the user's raw wallet — on-curve. If the recipient is on-curve,
    // this VAA was a direct user→user bridge and isn't ours to claim.
    if (PublicKey.isOnCurve(resolved.recipientOnSolana.toBytes())) {
      return {
        kind: 'noop',
        reason: `VAA recipient ${resolved.recipientOnSolana.toBase58()} is on-curve (raw wallet) — non-OnRe direct bridge, not claimable by relayer`,
      }
    }

    // Resolve userWallet. The VAA carries only the per-user inbox PDA
    // (recipient) and the intent_transfer setter PDA (sender) — neither
    // is invertible — so we recover the wallet from the FOGO source tx's
    // bridge_ntt_tokens source ATA owner. Cached across scans.
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
        // FOGO tx is unrecoverable (typically older than the FOGO RPC's
        // history retention — Solana-fork validators keep a few days).
        // Nothing the cranker can do; not an error, not actionable.
        return {
          kind: 'noop',
          reason: `FOGO tx ${input.fogoTx} not found — likely beyond RPC history retention; VAA recipient ${resolved.recipientOnSolana.toBase58()}`,
        }
      }
      // Validate the recovered wallet maps to the VAA recipient. Mismatch
      // means the FOGO tx wasn't actually an OnRe deposit — the source ATA
      // owner doesn't derive the inbox PDA the VAA targets. Noop.
      if (!deriveInboxAuthority(recovered).equals(resolved.recipientOnSolana)) {
        return {
          kind: 'noop',
          reason: `recovered wallet ${recovered.toBase58()} from FOGO tx ${input.fogoTx} doesn't derive VAA recipient ${resolved.recipientOnSolana.toBase58()} — not an OnRe deposit`,
        }
      }
      userWallet = recovered
      // The cache is wired as a `BoundedMap` in the daemon, so `set`
      // handles FIFO eviction at `USER_WALLET_CACHE_MAX`. Tests that
      // pass a plain `Map` get unbounded growth — fine at test scale.
      ctx.userWalletCache.set(input.fogoTx, recovered)
    }

    // Pre-flight 1: RelayerConfig must exist
    const cfg = await withTimeout(
      connection.getAccountInfo(client.configPda),
      ctx.rpcTimeoutMs,
      'getAccountInfo(RelayerConfig)',
    ).catch(() => null)
    if (!cfg) {
      return {
        kind: 'error',
        error: new Error(`RelayerConfig not found at ${client.configPda.toBase58()}`),
        partialSignatures: [],
      }
    }

    // Pre-flight 2: refuse to crank if Flow PDA already exists (someone
    // else got there first, or we already advanced this VAA).
    const existing = await client.fetchInflightFlow(resolved.nttInboxItem).catch(() => null)
    if (existing) {
      return {
        kind: 'noop',
        reason: `Flow already exists for inbox-item ${resolved.nttInboxItem.toBase58()} (status=${describeStatus(existing.status)})`,
      }
    }

    const [userInboxAuthority] = findUserInboxAuthorityPda(userWallet, client.program.programId)
    const userInboxAta = getAssociatedTokenAddressSync(usdcMint, userInboxAuthority, true)

    // Pre-flight 3: behavioural check for the on-chain InsufficientInboxBalance
    // failure (claim_usdc.rs:280: `user_inbox_ata.amount >= inbox.amount`).
    //
    // Failure shape: a prior claim_usdc/lock_onyc cycle ran NTT redeem+release
    // (creating the inbox-item, minting tokens to user_inbox_ata) and either
    // closed the Flow PDA (full success → cranker shouldn't re-pick this VAA,
    // but Wormholescan re-enumeration after Flow close still surfaces it) or
    // left the ATA drained for any other reason. With no Flow PDA, Pre-flight 2
    // doesn't catch it, NTT release is idempotent (skip path), and the
    // amount check fails permanently.
    //
    // Layout-aware reads live in `account-layouts.ts` — the sha256 binary
    // pins in `tests/utils/withdraw-scaffolding.ts` are the tripwire if
    // upstream layout drifts. If the inbox-item doesn't exist yet, this
    // is a fresh claim — proceed. If both exist and the ATA balance is
    // insufficient for the recorded inbox amount, the on-chain check
    // would always fail; noop instead.
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
          reason: `inbox-item ${resolved.nttInboxItem.toBase58()} exists with amount=${inboxAmount} but user_inbox_ata ${userInboxAta.toBase58()} balance=${ataAmount} — on-chain claim_usdc would fail at amount check (prior claim partially landed and tokens are gone, or VAA already fully advanced and re-enumerated). Unrecoverable from cranker.`,
        }
      }
    }

    // Pre-flight 4: derived inbox-authority must equal the VAA recipient
    if (!userInboxAuthority.equals(resolved.recipientOnSolana)) {
      return {
        kind: 'error',
        error: new Error(
          `derived inbox-authority PDA (${userInboxAuthority.toBase58()}) does not match VAA recipient (${resolved.recipientOnSolana.toBase58()})`,
        ),
        partialSignatures: [],
      }
    }

    const ensureUserInboxAtaIx = createAssociatedTokenAccountIdempotentInstruction(
      keypair.publicKey,
      userInboxAta,
      userInboxAuthority,
      usdcMint,
    )

    // Pre-step: ensure the USDC NTT `transceiver_message` PDA exists on
    // Solana, owned by the USDC NTT manager. Mirrors the same pattern
    // `unlock_onyc` uses — the on-chain `claim_usdc` handler declares
    // `ntt_transceiver_message` with `owner = NTT_USDC_PROGRAM_ID` and
    // can't create it itself (its CPI does redeem + release_inbound_mint,
    // both of which read the existing transceiver_message).
    //
    // Why this exists despite Wormhole's auto-relayer nominally
    // subscribing to USDC.s: in practice the auto-relayer is unreliable
    // — observed failures land as Anchor ConstraintOwner (2004) with
    // `Left=11111…, Right=nttu74Cd…SdGk`, i.e. the PDA is still System-
    // owned at submit time. Posting it ourselves is idempotent (probe
    // first) so concurrent auto-relayer + cranker posts cost one
    // redundant RPC.
    //
    // Bundled-mode NTT: `transceiver` and `expectedOwner` both equal
    // `nttProgram` because the manager program also serves as the
    // transceiver in OnRe's NTT v3 deploy.
    const prep = await prepareTransceiverMessage({
      connection,
      payer: keypair,
      vaaBytes,
      transceiverMessagePda: resolved.nttTransceiverMessage,
      manager: nttProgram,
      token: usdcMint,
      transceiver: nttProgram,
      expectedOwner: nttProgram,
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
    // tx small. Mirrors `unlock-onyc.ts`; same constant family.
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
      .claimUsdc({
        payer: keypair.publicKey,
        userWallet,
        usdcMint,
        nttInboxItem: resolved.nttInboxItem,
        nttTransceiverMessage: resolved.nttTransceiverMessage,
        ntt: { transceiverAddress: nttProgram },
      })
      .preInstructions([makePriorityFeeIx(ctx.priorityFeeMicroLamports), ...fundIxs, ensureUserInboxAtaIx])
      .rpc()

    metrics.txSent.inc({ instruction: 'claim_usdc', result: 'ok' })
    metrics.flowAdvance.inc({ leg: 'deposit', from_status: 'Pending', to_status: 'Claimed' })

    return {
      kind: 'advanced',
      signatures: [sig],
      fromStatus: 'Pending',
      toStatus: 'Claimed',
    }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'claim_usdc', result: 'error' })
    // Anchor 6022 (RelayerInsufficientInboxBalance) is a benign race —
    // another cranker advanced claim_usdc + swap_usdc_to_onyc between our
    // pre-flight 3 (TOCTOU window) and our submit. Classifier in
    // `race-classifier.ts` is the single source of truth for which codes
    // count as "lost race"; downgrade those to noop so the FSM doesn't
    // burn cooldown on a flow already further along the chain.
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
