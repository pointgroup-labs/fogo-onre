import type { AdvanceContext, AdvanceResult } from './types'
import { findUserInboxAuthorityPda, NTT_USDC_PROGRAM_ID, USDC_MINT } from '@fogo-onre/sdk'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { withTimeout } from '../rpc'
import { resolveNttVaa } from '../vaa'
import { describeStatus, fetchVaaBytes } from './helpers'

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

    // Auto-detect userWallet (see CLI:170-206 for the rationale)
    function deriveInboxAuthority(wallet: PublicKey): PublicKey {
      const [pda] = findUserInboxAuthorityPda(wallet, client.program.programId)
      return pda
    }
    let userWallet: PublicKey
    if (input.userWallet) {
      userWallet = input.userWallet
    } else if (deriveInboxAuthority(keypair.publicKey).equals(resolved.recipientOnSolana)) {
      userWallet = keypair.publicKey
    } else if (deriveInboxAuthority(resolved.senderOnSource).equals(resolved.recipientOnSolana)) {
      userWallet = resolved.senderOnSource
    } else {
      // Neither candidate matches — this VAA's recipient PDA cannot be
      // re-derived from any wallet the cranker can guess. The deposit was
      // either initiated by a Fogo Session keypair the cranker doesn't
      // know about, or the VAA is malformed. Either way, the cranker
      // can't advance it — surface as error so the operator can intervene.
      return {
        kind: 'error',
        error: new Error(
          `cannot derive userWallet for VAA recipient ${resolved.recipientOnSolana.toBase58()}; `
          + `tried [signer=${keypair.publicKey.toBase58()}, vaaSender=${resolved.senderOnSource.toBase58()}]`,
        ),
        partialSignatures: [],
      }
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
