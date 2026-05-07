import type { Connection, PublicKey } from '@solana/web3.js'
import type { SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import { withTimeout } from '../rpc'
import { WormholescanClient } from '../wormholescan'

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

export interface FlowAccount {
  fogoSender: number[] | Uint8Array
  status: { claimed?: object, swapped?: object, redemptionPending?: object }
  amount: { toString: () => string }
  payer: PublicKey
}

export function describeStatus(status: FlowAccount['status']): string {
  if (status.claimed !== undefined) {
    return 'Claimed'
  }
  if (status.swapped !== undefined) {
    return 'Swapped'
  }
  if (status.redemptionPending !== undefined) {
    return 'RedemptionPending'
  }
  return 'Unknown'
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
 *
 * `SolanaNtt` is dynamic-imported here to avoid a vitest module-resolution
 * snag in `@wormhole-foundation/sdk-solana-ntt`'s ESM build (it does
 * `import './side-effects'` without a `.js` extension, which Node's
 * strict ESM rejects at static analysis time but tolerates at runtime).
 */
export async function makeSolanaNtt(args: MakeSolanaNttArgs): Promise<SolanaNtt<'Mainnet', 'Solana'>> {
  const { SolanaNtt: SolanaNttCtor } = await import('@wormhole-foundation/sdk-solana-ntt')
  return new SolanaNttCtor(
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
 * a `SolanaNtt` instance. Index positions match the mainnet tx
 * `3NR6EEbk…` ordering pinned in `sdk-ntt-release.test.ts`.
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
    wormholeMessage: k[3].pubkey,
    emitter: k[4].pubkey,
    wormholeBridge: k[6].pubkey,
    wormholeFeeCollector: k[7].pubkey,
    wormholeSequence: k[8].pubkey,
    wormholeProgram: k[9].pubkey,
    outboxItemSigner: k[14].pubkey,
  }
}

export const WORMHOLE_CORE_MAINNET = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'
export const DEFAULT_NTT_VERSION = '3.0.0'
