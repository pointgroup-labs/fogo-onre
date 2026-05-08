import type { Connection } from '@solana/web3.js'
import { WormholescanClient } from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import { withTimeout } from '../rpc'

export interface FetchVaaArgs {
  fogoTx: string
  vaaHex?: string
  wormholescanUrl: string
  timeoutMs: number
}

/**
 * Resolve VAA bytes either from the inline `--vaa <HEX>` fallback or by
 * querying Wormholescan for the source-chain tx. Wrapped in `withTimeout`
 * so a hung Wormholescan can't wedge the daemon's scan loop.
 */
export async function fetchVaaBytes(args: FetchVaaArgs): Promise<Uint8Array> {
  if (args.vaaHex) {
    const hex = args.vaaHex.startsWith('0x') ? args.vaaHex.slice(2) : args.vaaHex
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
      throw new Error('vaaHex must be a hex string (optional 0x prefix)')
    }
    return Uint8Array.from(Buffer.from(hex, 'hex'))
  }
  const wh = new WormholescanClient({ baseUrl: args.wormholescanUrl })
  const bytes = await withTimeout(
    wh.resolveVaaByTxHash(args.fogoTx),
    args.timeoutMs,
    'wormholescan.resolveVaaByTxHash',
  )
  if (!bytes) {
    throw new Error(
      `Wormholescan returned no VAA for tx ${args.fogoTx} — `
      + `guardians may not have observed it yet (typical lag: a few seconds), `
      + `or the tx didn't emit a Wormhole message.`,
    )
  }
  return bytes
}

export interface MakeSolanaNttArgs {
  connection: Connection
  manager: PublicKey
  token: PublicKey
  wormholeCore: string
  version: string
}

/**
 * Build a `SolanaNtt` instance configured for the OnRe ONyc deployment.
 * Transceiver is baked into the manager binary, so `transceiver.wormhole = manager`.
 */
export function makeSolanaNtt(args: MakeSolanaNttArgs): SolanaNtt<'Mainnet', 'Solana'> {
  return new SolanaNtt(
    'Mainnet',
    'Solana',
    args.connection,
    {
      coreBridge: args.wormholeCore,
      ntt: {
        manager: args.manager.toBase58(),
        token: args.token.toBase58(),
        transceiver: { wormhole: args.manager.toBase58() },
      },
    },
    args.version,
  )
}

/**
 * Derive the 7-pubkey `release` argument for `client.lockOnyc({...})` from
 * a `SolanaNtt` instance. Index positions match the NTT v3 IDL for
 * `releaseWormholeOutbound` (verified against
 * `idl/3_0_0/json/example_native_token_transfers.json`):
 *   k[ 3] = transceiver (registered_transceiver PDA)
 *   k[ 4] = wormhole_message (writable, init'd by NTT v3)
 *   k[ 5] = emitter
 *   k[ 6] = wormhole.bridge
 *   k[ 7] = wormhole.fee_collector
 *   k[ 8] = wormhole.sequence
 *   k[ 9] = wormhole.program
 *   k[14] = outbox_item_signer (v3)
 */
export async function deriveLockOnycReleaseAccounts(
  ntt: SolanaNtt<'Mainnet', 'Solana'>,
  payer: PublicKey,
  outboxItem: PublicKey,
): Promise<{
  wormholeProgram: PublicKey
  wormholeBridge: PublicKey
  wormholeFeeCollector: PublicKey
  wormholeSequence: PublicKey
  outboxItemSigner: PublicKey
  wormholeMessage: PublicKey
  emitter: PublicKey
}> {
  const xcvr = await ntt.getWormholeTransceiver()
  if (!xcvr) {
    throw new Error('SolanaNttWormholeTransceiver wiring failed.')
  }
  const releaseIx = await xcvr.createReleaseWormholeOutboundIx(payer, outboxItem, false)
  const k = releaseIx.keys
  return {
    wormholeMessage: k[4].pubkey,
    emitter: k[5].pubkey,
    wormholeBridge: k[6].pubkey,
    wormholeFeeCollector: k[7].pubkey,
    wormholeSequence: k[8].pubkey,
    wormholeProgram: k[9].pubkey,
    outboxItemSigner: k[14].pubkey,
  }
}

export const WORMHOLE_CORE_MAINNET = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'
export const DEFAULT_NTT_VERSION = '3.0.0'
