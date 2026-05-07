/**
 * Wormhole-SDK orchestration for FOGO → Solana USDC.s NTT bridging.
 *
 * Isolated in its own module so the (heavy) Wormhole bundle can be
 * dynamically imported on demand from `depositContext.ts` and stays
 * out of the initial page load.
 *
 * Single export: `fetchUsdcSDepositQuote()` returns:
 *   - `signedQuoteBytes` — the 165-byte signed quote from the Wormhole
 *     executor service (`https://executor.labsapis.com/v0/quote`,
 *     baked-in by `@wormhole-foundation/sdk-route-ntt`).
 *   - `nttSubAccounts` — the full `NttBridgeSubAccounts` constellation
 *     (including `payeeNttWithExecutor` from the per-quote payee),
 *     derived via `NTT.pdas` / `NTT.transceiverPdas` /
 *     `utils.getWormholeDerivedAccounts`.
 *
 * Mirrors `buildWormholeTransfer + getNttPdas` from
 * `@fogo/sessions-sdk` (which we cannot reuse directly because its
 * `bridgeOut` hardcodes the recipient to the wallet pubkey — for
 * OnRe deposits we need the per-user inbox PDA on Solana). Every
 * non-trivial line below is a transcription of that source so the two
 * stay in lockstep on SDK bumps.
 */

import type { NttBridgeSubAccounts } from '@fogo-onre/sdk'
import { Network } from '@fogo/sessions-sdk-react'
import { PublicKey } from '@solana/web3.js'
import { Wormhole, wormhole } from '@wormhole-foundation/sdk'
import { contracts } from '@wormhole-foundation/sdk-base'
import * as routes from '@wormhole-foundation/sdk-connect/routes'
import { nttExecutorRoute } from '@wormhole-foundation/sdk-route-ntt'
import { utils } from '@wormhole-foundation/sdk-solana-core'
import { NTT, register as registerNttSolana } from '@wormhole-foundation/sdk-solana-ntt'
import solanaSdk from '@wormhole-foundation/sdk/solana'
import { FOGO_DEPOSIT_LUT_OVERRIDE, FOGO_NETWORK } from '@/constants'
import { formatBaseUnitsExact } from '@/utils/transfer'

// `@wormhole-foundation/sdk-solana-ntt` exposes a `register()` that
// installs the NTT protocol on the Solana platform. Idempotent — safe
// to call from a top-level module load. Mirrors sessions-sdk
// (`registerNtt()` at index.js:27).
registerNttSolana()

/**
 * Bridging address-lookup-table per `(network, source-mint)`. Mirrors
 * `BRIDGING_ADDRESS_LOOKUP_TABLE` in `@fogo/sessions-sdk` (`index.js:532`).
 * This LUT is pre-populated by Fogo Labs with the union of intent_transfer
 * + NTT-manager accounts that `bridge_ntt_tokens` touches — using it in
 * place of the per-manager `["lut"]` wrapper PDA shrinks the tx enough to
 * fit Solana's 1232-byte legacy-tx limit. The wrapper PDA only covers
 * NTT-side accounts, leaving the intent_transfer side uncompressed.
 */
const BRIDGING_LUT_BY_USDC_S_MINT: Record<Network, string> = {
  [Network.Mainnet]: '7hmMz3nZDnPJfksLuPotKmUBAFDneM2D9wWg3R1VcKSv',
  [Network.Testnet]: '4FCi6LptexBdZtaePsoCMeb1XpCijxnWu96g5LsSb6WP',
}

const NETWORK_TO_WORMHOLE_NETWORK = {
  [Network.Mainnet]: 'Mainnet',
  [Network.Testnet]: 'Testnet',
} as const

/**
 * Mirror of the `USDC` constant in `@fogo/sessions-sdk-react/wormhole-routes`.
 * The package's `exports` map only publishes the main entry, so we
 * inline the values here. They're stable on-chain identifiers — drift
 * would require a Wormhole NTT redeploy on either chain, which would
 * trigger a coordinated SDK bump anyway. Keep this in lockstep with the
 * upstream `wormhole-routes.js` on every `@fogo/sessions-sdk-react` bump.
 */
const WORMHOLE_USDC = {
  chains: {
    [Network.Mainnet]: {
      fogo: {
        chain: 'Fogo' as const,
        manager: new PublicKey('nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk'),
        mint: new PublicKey('uSd2czE61Evaf76RNbq4KPpXnkiL3irdzgLFUMe3NoG'),
        transceiver: new PublicKey('9ioH2HQmVsnbmA8Ej5o1LCAHPRisS8of4whyjCNHJXiw'),
      },
      solana: {
        chain: 'Solana' as const,
        manager: new PublicKey('nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk'),
        mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        transceiver: new PublicKey('9ioH2HQmVsnbmA8Ej5o1LCAHPRisS8of4whyjCNHJXiw'),
      },
    },
    [Network.Testnet]: {
      fogo: {
        chain: 'Fogo' as const,
        manager: new PublicKey('NTtktYPsu3a9fvQeuJW6Ea11kinvGc7ricT1iikaTue'),
        mint: new PublicKey('ELNbJ1RtERV2fjtuZjbTscDekWhVzkQ1LjmiPsxp5uND'),
        transceiver: new PublicKey('GJVgi8cwwUuyjjzM19xnT3KNYoX4pXvpp8UAS3ikgZLB'),
      },
      solana: {
        chain: 'Solana' as const,
        manager: new PublicKey('NTtktYPsu3a9fvQeuJW6Ea11kinvGc7ricT1iikaTue'),
        mint: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
        transceiver: new PublicKey('BLu7SyjSHWZVsiSSWhx3f3sL11rBpuzRYM1HyobVZR4v'),
      },
    },
  },
  decimals: 6,
}

export interface FetchUsdcSDepositQuoteParams {
  /** The user's FOGO wallet pubkey. */
  walletPublicKey: PublicKey
  /** Per-user inbox PDA on Solana — the deposit's true recipient. */
  recipientOnSolana: PublicKey
  /** Bridge amount in base units (USDC.s = 6 decimals). */
  amount: bigint
  /** Outbox-item keypair pubkey (caller adds the Keypair to extraSigners). */
  outboxItem: PublicKey
  /** Solana RPC endpoint — passed straight to `wormhole({chains})`. */
  solanaRpcUrl: string
  /** Pubkey that signs `bridge_ntt_tokens` — the intent_transfer setter PDA. */
  intentTransferSetter: PublicKey
}

export interface FetchUsdcSDepositQuoteResult {
  signedQuoteBytes: Uint8Array
  ntt: NttBridgeSubAccounts
  /**
   * The FOGO USDC.s NTT manager's published address-lookup table
   * (`["lut"]` under the manager program). The unrolled `bridge_ntt_tokens`
   * ix references ~30 distinct accounts and won't fit in a 1232-byte
   * legacy tx — passing this LUT to `sendTransaction({ addressLookupTable })`
   * gets the manager-side accounts (config, peer, custody, transceiver,
   * wormhole bridge, etc.) into the LUT-indexed slots so only the
   * intent_transfer-side accounts have to be in the tx body.
   */
  addressLookupTable: PublicKey
}

/**
 * One-shot helper: fetches the executor quote AND derives every NTT
 * sub-account the `bridge_ntt_tokens` ix needs, in a single call so the
 * caller doesn't have to sequence two async dances.
 */
export async function fetchUsdcSDepositQuote(
  params: FetchUsdcSDepositQuoteParams,
): Promise<FetchUsdcSDepositQuoteResult> {
  const { walletPublicKey, recipientOnSolana, amount, outboxItem, solanaRpcUrl, intentTransferSetter } = params

  const fromToken = WORMHOLE_USDC.chains[FOGO_NETWORK].fogo
  const toToken = WORMHOLE_USDC.chains[FOGO_NETWORK].solana
  const decimals = WORMHOLE_USDC.decimals

  const wh = await wormhole(NETWORK_TO_WORMHOLE_NETWORK[FOGO_NETWORK], [solanaSdk], {
    chains: { Solana: { rpc: solanaRpcUrl } },
  })

  // Build a single-token NTT route covering Fogo↔Solana USDC.s. The
  // executor (`https://executor.labsapis.com`) is hardcoded inside the
  // route module — no URL config to thread.
  const Route = nttExecutorRoute({
    ntt: {
      tokens: {
        USDC: [
          {
            chain: fromToken.chain,
            manager: fromToken.manager.toBase58(),
            token: fromToken.mint.toBase58(),
            transceiver: [{ address: fromToken.transceiver.toBase58(), type: 'wormhole' }],
          },
          {
            chain: toToken.chain,
            manager: toToken.manager.toBase58(),
            token: toToken.mint.toBase58(),
            transceiver: [{ address: toToken.transceiver.toBase58(), type: 'wormhole' }],
          },
        ],
      },
    },
  })
  const route = new Route(wh)
  const transferRequest = await routes.RouteTransferRequest.create(wh, {
    destination: Wormhole.tokenId(toToken.chain, toToken.mint.toBase58()),
    // Recipient on the destination chain: the per-user inbox PDA, NOT
    // the user's wallet pubkey. This is the entire reason we don't
    // reuse sessions-sdk's `bridgeOut` directly.
    recipient: Wormhole.chainAddress(toToken.chain, recipientOnSolana.toBase58()),
    source: Wormhole.tokenId(fromToken.chain, fromToken.mint.toBase58()),
  })
  const validated = await route.validate(transferRequest, {
    amount: formatBaseUnitsExact(amount, decimals),
    options: route.getDefaultOptions(),
  })
  if (!validated.valid) {
    throw validated.error
  }
  // The wormhole client's TS surface lies about `fetchExecutorQuote`'s
  // visibility — it's part of the runtime API. Sessions-sdk uses the
  // same `@ts-expect-error` workaround.
  //
  // `payeeAddress` is declared in `signedQuoteLayout` as
  // `{ binary: "bytes", size: 32 }`, so the deserialized value is a raw
  // 32-byte `Uint8Array` — not a `UniversalAddress` wrapper. Pass the
  // bytes straight to `new PublicKey(Uint8Array)`.
  const quote = await (route as unknown as {
    fetchExecutorQuote: (
      r: typeof transferRequest,
      p: typeof validated.params,
    ) => Promise<{ signedQuote: Uint8Array, payeeAddress: Uint8Array }>
  }).fetchExecutorQuote(transferRequest, validated.params)

  const payeeAddress = new PublicKey(quote.payeeAddress)
  const ntt = await deriveNttSubAccounts({
    fromTokenManager: fromToken.manager,
    fromTokenMint: fromToken.mint,
    walletPublicKey,
    recipientOnSolana,
    outboxItem,
    intentTransferSetter,
    amount,
    wh,
  })

  // Prefer our custom union LUT (mirror of bridging LUT + 7 globals
  // that escape it when fee_token = wFOGO) when deployed; fall back
  // to the Sessions-SDK bridging LUT otherwise. See
  // `scripts/deploy-fogo-deposit-lut.mjs` and
  // `FOGO_DEPOSIT_LUT_OVERRIDE` in `constants.ts`.
  const lutAddress = FOGO_DEPOSIT_LUT_OVERRIDE ?? BRIDGING_LUT_BY_USDC_S_MINT[FOGO_NETWORK]
  return {
    signedQuoteBytes: new Uint8Array(quote.signedQuote),
    ntt: { ...ntt, payeeNttWithExecutor: payeeAddress },
    addressLookupTable: new PublicKey(lutAddress),
  }
}

interface DeriveNttArgs {
  fromTokenManager: PublicKey
  fromTokenMint: PublicKey
  walletPublicKey: PublicKey
  recipientOnSolana: PublicKey
  outboxItem: PublicKey
  intentTransferSetter: PublicKey
  amount: bigint
  wh: Awaited<ReturnType<typeof wormhole>>
}

/**
 * Mirrors sessions-sdk `getNttPdas` (index.js:778-810) line-for-line,
 * with two deliberate substitutions:
 *   - The recipient bound into `nttSessionAuthority`'s args-keccak is
 *     the per-user inbox PDA (not the wallet pubkey).
 *   - `payeeNttWithExecutor` is filled by the caller with the
 *     quote-published payee address.
 */
function deriveNttSubAccounts(args: DeriveNttArgs): Promise<Omit<NttBridgeSubAccounts, 'payeeNttWithExecutor'>> {
  const { fromTokenManager, fromTokenMint, recipientOnSolana, outboxItem, intentTransferSetter, amount, wh } = args

  const pdas = NTT.pdas(fromTokenManager)
  const transceiverPdas = NTT.transceiverPdas(fromTokenManager)
  const solana = wh.getChain('Solana')
  const coreBridgeContract = contracts.coreBridge.get(wh.network, 'Fogo')
  if (coreBridgeContract === undefined) {
    throw new Error('Wormhole core bridge contract not registered for Fogo on this network.')
  }
  const wormholePdas = utils.getWormholeDerivedAccounts(fromTokenManager, coreBridgeContract)
  const [registeredTransceiverPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('registered_transceiver'), fromTokenManager.toBytes()],
    fromTokenManager,
  )

  // `NTT.custodyAccountAddress` is async (loads token-program metadata
  // under the hood). Wrap the synchronous PDA derivations in a single
  // Promise.resolve and await the custody read alongside.
  return NTT.custodyAccountAddress(pdas, fromTokenMint).then(nttCustody => ({
    nttManager: fromTokenManager,
    nttConfig: pdas.configAccount(),
    nttCustody,
    nttInboxRateLimit: pdas.inboxRateLimitAccount(solana.chain),
    nttOutboxItem: outboxItem,
    nttOutboxRateLimit: pdas.outboxRateLimitAccount(),
    nttPeer: pdas.peerAccount(solana.chain),
    nttSessionAuthority: pdas.sessionAuthority(
      intentTransferSetter,
      NTT.transferArgs(amount, Wormhole.chainAddress('Solana', recipientOnSolana.toBase58()), false),
    ),
    nttTokenAuthority: pdas.tokenAuthority(),
    transceiver: registeredTransceiverPda,
    emitter: transceiverPdas.emitterAccount(),
    wormholeBridge: wormholePdas.wormholeBridge,
    wormholeFeeCollector: wormholePdas.wormholeFeeCollector,
    wormholeMessage: transceiverPdas.wormholeMessageAccount(outboxItem),
    wormholeProgram: new PublicKey(coreBridgeContract),
    wormholeSequence: wormholePdas.wormholeSequence,
    nttWithExecutorProgram: new PublicKey('nex1gkSWtRBheEJuQZMqHhbMG5A45qPU76KqnCZNVHR'),
    executorProgram: new PublicKey('execXUrAsMnqMmTHj5m7N1YQgsDz3cwGLYCYyuDRciV'),
  }))
}
