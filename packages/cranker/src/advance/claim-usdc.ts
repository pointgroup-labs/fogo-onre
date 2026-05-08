import type { AdvanceContext, AdvanceResult } from './types'
import { findUserInboxAuthorityPda, NTT_USDC_PROGRAM_ID, USDC_MINT } from '@fogo-onre/sdk'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { withTimeout } from '../rpc'
import { resolveNttVaa } from '../vaa'
import { deriveUserWalletFromFogoTx, describeStatus, fetchVaaBytes } from './helpers'

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
          15_000,
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
      ctx.userWalletCache.set(input.fogoTx, recovered)
    }

    // Pre-flight 1: RelayerConfig must exist
    const cfg = await withTimeout(
      connection.getAccountInfo(client.configPda),
      15_000,
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
    // We compare the two values the on-chain handler compares using fixed-offset
    // byte reads:
    //   - inbox.amount: NTT InboxItem layout = [disc(8) | init(1) | bump(1) |
    //     amount(u64 LE) | ...] → offset 10
    //   - ata.amount:   SPL TokenAccount layout = [mint(32) | owner(32) |
    //     amount(u64 LE) | ...] → offset 64
    //
    // If the inbox-item doesn't exist yet, this is a fresh claim — proceed.
    // If both exist and the ATA balance is insufficient for the recorded
    // inbox amount, the on-chain check would always fail; noop instead.
    const [inboxInfo, ataInfo] = await Promise.all([
      withTimeout(
        connection.getAccountInfo(resolved.nttInboxItem),
        15_000,
        'getAccountInfo(NttInboxItem)',
      ).catch(() => null),
      withTimeout(
        connection.getAccountInfo(userInboxAta),
        15_000,
        'getAccountInfo(userInboxAta)',
      ).catch(() => null),
    ])
    if (inboxInfo && inboxInfo.data.length >= 18) {
      const inboxAmount = inboxInfo.data.readBigUInt64LE(10)
      const ataAmount = ataInfo && ataInfo.data.length >= 72
        ? ataInfo.data.readBigUInt64LE(64)
        : 0n
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

    const sig = await client
      .claimUsdc({
        payer: keypair.publicKey,
        userWallet,
        usdcMint,
        nttInboxItem: resolved.nttInboxItem,
        nttTransceiverMessage: resolved.nttTransceiverMessage,
        ntt: { transceiverAddress: nttProgram },
      })
      .preInstructions([ensureUserInboxAtaIx])
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
    return {
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      partialSignatures: [],
    }
  }
}
