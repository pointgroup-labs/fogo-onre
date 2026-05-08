import type { NttInboxItem, ResolvedNttVaa } from '@fogo-onre/sdk'
import type { BridgeContext, BridgePlan, BridgeRedeemResult, BridgeRedeemTarget } from './types'
import {
  buildFogoNttReleaseInboundMintIx,
  buildFogoNttReleaseInboundUnlockIx,
  decodeNttInboxItem,
  resolveNttVaa,
} from '@fogo-onre/sdk'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import { errorFields } from '../utils/log'
import { withTimeout } from '../utils/rpc'
import { executeSdkBundledRedeem } from './sdk-redeem'

/**
 * Decide what to do with a single bridge VAA against a destination
 * target. Pure-ish: only does dest-RPC reads + PDA derivation, no tx
 * submit. Returns a `BridgePlan` the engine can submit (or a tests can
 * assert against).
 *
 * Three branches based on inbox-item state:
 *
 *   - **missing** → submit redeem + release (full tx).
 *   - **present, not yet released** → submit release-only (skip redeem,
 *     which would no-op anyway under Anchor's `init_if_needed` semantics
 *     but costs CU).
 *   - **present, released** → noop (final state).
 *
 * Plus a couple of upstream filters (toChain match, dest-side preflight
 * gates) to skip junk VAAs early.
 */
export async function planBridgeRedeem(
  ctx: BridgeContext,
  target: BridgeRedeemTarget,
  vaaBytes: Uint8Array,
): Promise<{ plan: BridgePlan, resolved?: ResolvedNttVaa }> {
  // Filter 0: dest-side governance not yet wired. Submitting would
  // 100% fail with `AccountDiscriminatorNotFound (0xbb9)` and burn SOL,
  // so we noop loudly. Operator gets the precise missing PDA from the
  // startup-probe error attached to the target.
  if (!target.configReady) {
    return {
      plan: {
        action: 'noop',
        reason: `ntt-not-configured: ${target.configError ?? 'governance state missing'}`,
        ixs: [],
      },
    }
  }

  let resolved: ResolvedNttVaa
  try {
    resolved = resolveNttVaa({
      vaaBytes,
      nttProgramId: target.destNttManagerProgramId,
      transceiverProgramId: target.destWhTransceiverProgramId,
    })
  } catch (err) {
    return {
      plan: { action: 'noop', reason: `unparseable as NTT VAA: ${(err as Error).message}`, ixs: [] },
    }
  }

  // Filter 1: addressed to our destination chain. The source emitter can
  // emit VAAs to any chain (manager-level config), so polling alone is
  // insufficient. Without this gate every cross-chain ONyc VAA targeting
  // some other chain would attempt a FOGO-side redeem and fail.
  if (resolved.manager.toChain !== target.destChainId) {
    return {
      plan: {
        action: 'noop',
        reason: `VAA toChain=${resolved.manager.toChain} does not match target dest chain ${target.destChainId}`,
        ixs: [],
      },
      resolved,
    }
  }

  // Filter 2: source emitter chain matches the target's source. Same
  // rationale — defense in depth in case Wormholescan returns mistagged
  // data, or someone hand-feeds a VAA via the CLI.
  if (resolved.fromChain !== target.sourceChainId) {
    return {
      plan: {
        action: 'noop',
        reason: `VAA fromChain=${resolved.fromChain} does not match target source chain ${target.sourceChainId}`,
        ixs: [],
      },
      resolved,
    }
  }

  // Branch on dest-side inbox-item state.
  const inboxInfo = await withTimeout(
    target.destConnection.getAccountInfo(resolved.nttInboxItem),
    ctx.rpcTimeoutMs,
    'dest.getAccountInfo(InboxItem)',
  ).catch((err) => {
    ctx.log.warn('inbox-item RPC failed', {
      target: target.name,
      inboxItem: resolved.nttInboxItem.toBase58(),
      ...errorFields(err),
    })
    ctx.metrics.rpcErrors.inc({ endpoint: 'dest', kind: 'getAccountInfo' })
    return null
  })

  let inboxState: NttInboxItem | null = null
  if (inboxInfo) {
    try {
      inboxState = decodeNttInboxItem(Buffer.from(inboxInfo.data))
    } catch (err) {
      // Account exists at the PDA but isn't a valid InboxItem — extremely
      // suspicious (e.g. bytes from an older NTT version or unrelated
      // program collision). Refuse to act; require human triage.
      return {
        plan: {
          action: 'noop',
          reason: `inbox-item ${resolved.nttInboxItem.toBase58()} present but not decodable as NttInboxItem: ${(err as Error).message}`,
          ixs: [],
        },
        resolved,
      }
    }
  }

  if (inboxState?.releaseStatus.kind === 'Released') {
    return {
      plan: {
        action: 'noop',
        reason: `inbox-item ${resolved.nttInboxItem.toBase58()} already Released`,
        ixs: [],
      },
      resolved,
    }
  }

  if (
    inboxState?.releaseStatus.kind === 'ReleaseAfter'
    && inboxState.releaseStatus.timestamp > BigInt(Math.floor(Date.now() / 1000))
  ) {
    return {
      plan: {
        action: 'noop',
        reason: `inbox-item gated until ts=${inboxState.releaseStatus.timestamp.toString()} (rate-limit delay)`,
        ixs: [],
      },
      resolved,
    }
  }

  const recipientWallet = resolved.recipientOnSolana
  const recipientAta = getAssociatedTokenAddressSync(target.destMint, recipientWallet, false)

  const ensureAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    target.destSigner.publicKey,
    recipientAta,
    recipientWallet,
    target.destMint,
  )

  const releaseIx = (target.destReleaseMode === 'Burning'
    ? buildFogoNttReleaseInboundMintIx
    : buildFogoNttReleaseInboundUnlockIx)({
    payer: target.destSigner.publicKey,
    nttManagerProgramId: target.destNttManagerProgramId,
    mint: target.destMint,
    nttInboxItem: resolved.nttInboxItem,
    recipientAta,
  })

  if (!inboxState) {
    // Inbox-missing: the SDK pipeline (executeSdkBundledRedeem) owns the
    // full receive_message + redeem + release sequence as one bundle, so
    // we no longer probe `transceiver_message` here — empty is the normal
    // case and the SDK creates it. The ix list below is intentionally
    // empty: executeBridgePlan ignores plan.ixs for `redeem-and-release`
    // and delegates to the SDK, which builds its own transactions.
    return {
      plan: {
        action: 'redeem-and-release',
        ixs: [],
      },
      resolved,
    }
  }

  // Inbox exists, NotApproved or ReleaseAfter (past) — release only.
  return {
    plan: {
      action: 'release-only',
      ixs: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ensureAtaIx,
        releaseIx,
      ],
    },
    resolved,
  }
}

/**
 * Submit a planned bridge redeem. Single tx so a partial land doesn't
 * leave inbox written without ONyc minted.
 */
export async function executeBridgePlan(
  ctx: BridgeContext,
  target: BridgeRedeemTarget,
  plan: BridgePlan,
  vaaBytes: Uint8Array,
): Promise<BridgeRedeemResult> {
  if (plan.action === 'noop') {
    ctx.metrics.redeemed.inc({ target: target.name, result: 'noop' })
    return { kind: 'noop', reason: plan.reason ?? 'noop' }
  }

  if (plan.action === 'redeem-and-release') {
    // Delegate to the upstream SDK pipeline so we can land
    // post_vaa + receive_message + redeem + release in bundled mode
    // without an external Wormhole executor. The hand-built `plan.ixs`
    // assumed `transceiver_message` already existed; the SDK creates it.
    return executeSdkBundledRedeem(ctx, target, vaaBytes)
  }

  const tx = new Transaction().add(...plan.ixs)
  try {
    const sig = await withTimeout(
      sendAndConfirmTransaction(target.destConnection, tx, [target.destSigner], {
        commitment: 'confirmed',
        skipPreflight: false,
      }),
      ctx.txConfirmTimeoutMs,
      `dest.sendAndConfirmTransaction(${plan.action})`,
    )
    ctx.metrics.redeemed.inc({ target: target.name, result: 'ok' })
    ctx.metrics.txSent.inc({ instruction: `bridge_${plan.action.replace(/-/g, '_')}`, result: 'ok' })
    return { kind: 'submitted', signature: sig, action: plan.action }
  } catch (err) {
    ctx.metrics.redeemed.inc({ target: target.name, result: 'error' })
    ctx.metrics.txSent.inc({ instruction: `bridge_${plan.action.replace(/-/g, '_')}`, result: 'error' })
    return {
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
    }
  }
}
