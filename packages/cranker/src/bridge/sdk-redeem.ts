import type { BridgeContext, BridgeRedeemResult, BridgeRedeemTarget } from './types'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import { deserialize } from '@wormhole-foundation/sdk-definitions'
import { register as registerNttDefinitions } from '@wormhole-foundation/sdk-definitions-ntt'
import { register as registerSolanaNtt, SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import { errorFields } from '../utils/log'
import { isVersionedTransaction, makePriorityFeeIx } from '../utils/priority-fee'
import { withTimeout } from '../utils/rpc'

registerNttDefinitions()
registerSolanaNtt()

const NETWORK = 'Mainnet' as const
const FOGO_CHAIN = 'Fogo' as const
// FOGO mainnet has its OWN Wormhole Core deployment, not Solana's.
// Source: @wormhole-foundation/sdk-base mainnet contracts registry
// (constants/contracts/core.js → ["Fogo", "worm2mrQk..."]). Required by
// SolanaNtt's internal SolanaWormholeCore for postVaa / verify-sigs.
const FOGO_WORMHOLE_CORE = 'worm2mrQkG1B1KTz37erMfWN8anHkSK24nzca7UD8BB'
const NTT_VERSION = '3.0.0'

type FogoNtt = SolanaNtt<typeof NETWORK, typeof FOGO_CHAIN>

const nttCache = new Map<string, FogoNtt>()

function getOrCreateSolanaNtt(target: BridgeRedeemTarget): FogoNtt {
  const managerStr = target.destNttManagerProgramId.toBase58()
  const transceiverStr = target.destWhTransceiverProgramId.toBase58()
  const key = `${NETWORK}|${managerStr}`
  const cached = nttCache.get(key)
  if (cached) {
    return cached
  }
  const ntt = new SolanaNtt(
    NETWORK,
    FOGO_CHAIN,
    target.destConnection,
    {
      coreBridge: FOGO_WORMHOLE_CORE,
      ntt: {
        manager: managerStr,
        token: target.destMint.toBase58(),
        transceiver: { wormhole: transceiverStr },
      },
    },
    NTT_VERSION,
  )
  nttCache.set(key, ntt)
  return ntt
}

/**
 * Extract the recipient owner pubkey from a deserialized NTT VAA.
 *
 * NTT's `release_inbound_mint` (and `release_inbound_unlock`) expects
 * `recipient` to be an *already-initialized* SPL token account — Anchor
 * decodes it via the `Account<'_, TokenAccount>` constraint and aborts
 * with `AccountNotInitialized (3012, 0xbc4)` if the ATA hasn't been
 * created yet. The destination owner address sits in the inner
 * `nativeTokenTransfer.recipientAddress` field as a 32-byte
 * UniversalAddress; on Solana/FOGO that's just the owner pubkey.
 */
function extractRecipientOwner(
  vaa: Parameters<FogoNtt['redeem']>[0][number],
): PublicKey {
  // Layout: WormholeTransceiverMessage → NttManagerMessage → NativeTokenTransfer
  // SDK exposes the innermost record at vaa.payload.nttManagerPayload.payload.
  const nativeTransfer = (vaa.payload as { nttManagerPayload: { payload: { recipientAddress: { toUint8Array: () => Uint8Array } } } })
    .nttManagerPayload
    .payload
  return new PublicKey(nativeTransfer.recipientAddress.toUint8Array())
}

/**
 * Make sure the destination ATA the SDK is going to mint into exists.
 *
 * Always sends `createAssociatedTokenAccountIdempotent` rather than
 * probing first: the program-side ix is a no-op when the account
 * already exists, so the cost of an unconditional send (one extra
 * tx-fee per redeem cycle) is cheaper than the alternative of an
 * `getAccountInfo` round-trip plus a TOCTOU window where the ATA could
 * be created between probe and send.
 *
 * Returns the derived ATA so callers can log it.
 */
async function ensureRecipientAta(
  ctx: BridgeContext,
  target: BridgeRedeemTarget,
  vaa: Parameters<FogoNtt['redeem']>[0][number],
): Promise<{ ata: PublicKey, owner: PublicKey }> {
  const owner = extractRecipientOwner(vaa)
  const ata = getAssociatedTokenAddressSync(target.destMint, owner, true)

  const payer = target.destSigner.publicKey
  const ix = createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata,
    owner,
    target.destMint,
  )
  // Modest CU budget — ATA create is cheap, but the default 200k can
  // get out-prioritised on busy slots.
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 })
  const tx = new Transaction().add(makePriorityFeeIx(ctx.priorityFeeMicroLamports), cuLimit, ix)

  const sig = await withTimeout(
    sendAndConfirmTransaction(
      target.destConnection,
      tx,
      [target.destSigner],
      { commitment: 'confirmed', skipPreflight: false },
    ),
    ctx.txConfirmTimeoutMs,
    'dest.sendAndConfirmTransaction(ensure recipient ATA)',
  )

  ctx.metrics.txSent.inc({ instruction: 'ensure_recipient_ata', result: 'ok' })
  ctx.log.debug('ensured recipient ATA before redeem', {
    target: target.name,
    owner: owner.toBase58(),
    ata: ata.toBase58(),
    mint: target.destMint.toBase58(),
    signature: sig,
  })
  return { ata, owner }
}

/**
 * Run the upstream `SolanaNtt.redeem` pipeline against the destination
 * chain. Handles `post_vaa` + `wormhole-transceiver::receive_message` +
 * `redeem` + `release_inbound_*` in whatever order the SDK yields them
 * (potentially several txs for shim-mode large VAAs). Each yielded
 * `SolanaUnsignedTransaction` carries its own ephemeral `signers`
 * (e.g. shim signature accounts) which must be co-signed alongside the
 * configured operator key.
 *
 * Idempotent against a partially-landed chain: `getIsExecuted` short-
 * circuits to `noop` if some other path already finalized the VAA
 * between planning and execution.
 */
export async function executeSdkBundledRedeem(
  ctx: BridgeContext,
  target: BridgeRedeemTarget,
  vaaBytes: Uint8Array,
): Promise<BridgeRedeemResult> {
  const ntt = getOrCreateSolanaNtt(target)

  let vaa: Parameters<FogoNtt['redeem']>[0][number]
  try {
    vaa = deserialize('Ntt:WormholeTransfer', vaaBytes) as typeof vaa
  } catch (err) {
    ctx.metrics.redeemed.inc({ target: target.name, result: 'error' })
    ctx.log.warn('sdk-redeem deserialize failed', {
      target: target.name,
      ...errorFields(err),
    })
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }

  try {
    if (await ntt.getIsExecuted(vaa)) {
      ctx.metrics.redeemed.inc({ target: target.name, result: 'noop' })
      return { kind: 'noop', reason: 'already executed on dest' }
    }
  } catch (err) {
    ctx.log.debug('sdk-redeem getIsExecuted probe failed (continuing)', {
      target: target.name,
      ...errorFields(err),
    })
  }

  // Pre-flight: NTT's release_inbound_mint requires the recipient ATA
  // to be initialized; unconditionally send the idempotent ATA-create
  // ix. Done as a separate tx because the SDK builds the redeem bundle
  // from a fixed manager IDL — there's no clean injection point for an
  // ATA-create ix into its VersionedTransaction output.
  try {
    await ensureRecipientAta(ctx, target, vaa)
  } catch (err) {
    ctx.metrics.redeemed.inc({ target: target.name, result: 'error' })
    ctx.metrics.txSent.inc({ instruction: 'ensure_recipient_ata', result: 'error' })
    ctx.log.warn('failed to ensure recipient ATA before redeem', {
      target: target.name,
      ...errorFields(err),
    })
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }

  const payerPk = target.destSigner.publicKey
  let lastSig: string | null = null

  try {
    // SolanaNtt.redeem internally wraps `payer` with `new SolanaAddress(...)`,
    // which accepts a raw PublicKey. The TS signature wants an
    // `AccountAddress<'Fogo'>` so we cast — pulling in
    // `@wormhole-foundation/sdk-solana` just for the constructor would
    // duplicate a transitive dep. Mirrors the same cast in
    // `packages/cli/src/commands/cranker.ts` redeem path.
    for await (const unsigned of ntt.redeem(
      [vaa],
      payerPk as unknown as Parameters<typeof ntt.redeem>[1],
    )) {
      if (ctx.abortSignal.aborted) {
        return { kind: 'noop', reason: 'aborted mid-redeem' }
      }
      const stx = unsigned.transaction
      const description = unsigned.description
      const extraSigners = stx.signers ?? []
      const inner = stx.transaction

      let sig: string
      // **Do NOT inject our priority-fee ix here.** The Wormhole/NTT
      // SDK already embeds compute-budget pricing (setComputeUnitPrice +
      // setComputeUnitLimit) into every tx it yields from `redeem(...)`,
      // sized for the specific step it built. Layering a second
      // setComputeUnitPrice on top — even after filtering — produced
      // DuplicateInstruction (0x2) at simulation under pnpm's dual-
      // realm `@solana/web3.js` resolution (the SDK's Transaction
      // serialises via a different internal path than our
      // `.instructions` mutation, defeating any pre-submit dedup we do
      // from outside).
      //
      // The net effect is identical to the pre-rollout behaviour: this
      // path used to sign-and-send SDK-yielded txs verbatim, and it
      // worked. We keep our priority-fee injection only for txs we
      // build ourselves (`ensureRecipientAta`, the shim-mode helpers in
      // `prepareTransceiverMessage`, and `bridge/redeem.ts`), where the
      // SDK isn't in the loop.
      //
      // Cross-realm-safe detection of v0 vs legacy because the SDK and
      // we may resolve different physical copies of @solana/web3.js
      // under pnpm — see `isVersionedTransaction` for the rationale.
      if (isVersionedTransaction(inner)) {
        inner.sign([target.destSigner, ...extraSigners])
        const raw = inner.serialize()
        sig = await withTimeout(
          target.destConnection.sendRawTransaction(raw, { skipPreflight: false }),
          ctx.txConfirmTimeoutMs,
          `dest.sendRawTransaction(sdk-redeem:${description})`,
        )
        const latest = await target.destConnection.getLatestBlockhash('confirmed')
        await withTimeout(
          target.destConnection.confirmTransaction(
            { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
            'confirmed',
          ),
          ctx.txConfirmTimeoutMs,
          `dest.confirmTransaction(sdk-redeem:${description})`,
        )
      } else {
        const legacy = inner as Transaction
        sig = await withTimeout(
          sendAndConfirmTransaction(
            target.destConnection,
            legacy,
            [target.destSigner, ...extraSigners],
            { commitment: 'confirmed', skipPreflight: false },
          ),
          ctx.txConfirmTimeoutMs,
          `dest.sendAndConfirmTransaction(sdk-redeem:${description})`,
        )
      }

      lastSig = sig
      ctx.metrics.txSent.inc({ instruction: 'sdk_bundled_redeem_step', result: 'ok' })
      ctx.log.info('sdk-redeem step submitted', {
        target: target.name,
        signature: sig,
        description,
      })
    }
  } catch (err) {
    ctx.metrics.redeemed.inc({ target: target.name, result: 'error' })
    ctx.metrics.txSent.inc({ instruction: 'sdk_bundled_redeem_step', result: 'error' })
    ctx.log.warn('sdk-redeem step failed', {
      target: target.name,
      ...errorFields(err),
    })
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }

  if (!lastSig) {
    // Generator yielded nothing — SDK considered the work already done
    // but `getIsExecuted` returned false above. Treat as noop rather
    // than synthesize a fake signature; operator can re-poll next tick.
    ctx.metrics.redeemed.inc({ target: target.name, result: 'noop' })
    return { kind: 'noop', reason: 'sdk redeem yielded no transactions' }
  }

  ctx.metrics.redeemed.inc({ target: target.name, result: 'ok' })
  return { kind: 'submitted', signature: lastSig, action: 'redeem-and-release' }
}
