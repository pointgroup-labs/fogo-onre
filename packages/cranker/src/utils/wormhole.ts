import { WormholescanClient } from '@fogo-onre/sdk'
import { withTimeout } from './rpc'

export const WORMHOLE_CORE_MAINNET = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'
export const DEFAULT_NTT_VERSION = '3.0.0'

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
