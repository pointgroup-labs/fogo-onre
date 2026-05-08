import type { BridgeContext, BridgeRedeemResult, BridgeRedeemTarget } from './types'
import {
  sendAndConfirmTransaction,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js'
import { deserialize } from '@wormhole-foundation/sdk-definitions'
import { register as registerNttDefinitions } from '@wormhole-foundation/sdk-definitions-ntt'
import { register as registerSolanaNtt, SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import { errorFields } from '../utils/log'
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

  const payerPk = target.destSigner.publicKey
  let lastSig: string | null = null

  try {
    for await (const unsigned of ntt.redeem([vaa], payerPk)) {
      if (ctx.abortSignal.aborted) {
        return { kind: 'noop', reason: 'aborted mid-redeem' }
      }
      const stx = unsigned.transaction
      const description = unsigned.description
      const extraSigners = stx.signers ?? []
      const inner = stx.transaction

      let sig: string
      if (inner instanceof VersionedTransaction) {
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
