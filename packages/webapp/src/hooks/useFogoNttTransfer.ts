'use client'

import type {
  BuildBridgeOutIntentMessageParams,
  NttBridgeSubAccounts,
} from '@fogo-onre/sdk'
import type { SessionState } from '@fogo/sessions-sdk-react'
import type { TransactionInstruction } from '@solana/web3.js'
import type { TxStatus } from '@/utils/transfer'
import {
  buildBridgeNttTokensIx,
  buildBridgeOutIntentMessage,
  buildFogoNttWithdrawIx,
  buildIntentVerifierIx,
  findAuthorityPda,
  findUserInboxAuthorityPda,
  RELAYER_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { isEstablished, TransactionResultType } from '@fogo/sessions-sdk-react'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, PublicKey } from '@solana/web3.js'
import { useState } from 'react'
import {
  BONYC_MINT,
  FOGO_BONYC_NTT_MANAGER_ID,
  FOGO_BRIDGE_PAYMASTER_DOMAIN,
  FOGO_BRIDGE_VARIATION,
  USDC_S_MINT,
} from '@/constants'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'
import { error, idle, pending, success } from '@/utils/transfer'

/**
 * FOGO-side bridge hook covering both deposit (USDC.s → Solana relayer)
 * and withdraw (bONyc → Solana relayer authority PDA).
 *
 * The two branches use *structurally different* on-chain entry points:
 *
 * **Deposit** goes through FOGO's `intent_transfer.bridge_ntt_tokens`.
 * The user signs a `Fogo Bridge Transfer:` intent message whose
 * `recipient_address` is the per-user inbox PDA on Solana
 * (`findUserInboxAuthorityPda(wallet)`). The webapp then submits an
 * Ed25519 verifier ix + the `bridge_ntt_tokens` ix in one tx; the FOGO
 * paymaster sponsors gas via the active session. On Solana, the
 * relayer's `claim_usdc` validates that the VAA's NTT sender is
 * intent_transfer's setter PDA, then PDA-signs a sweep of exactly the
 * VAA's amount from the inbox ATA into relayer custody. Originator
 * attribution rides as `flow.fogo_sender = userWallet` (NOT as the
 * NTT sender field) so the return-leg `lock_onyc` knows where to bridge
 * bONyc back.
 *
 * **Withdraw** uses the unchanged FOGO NTT `transfer_burn` path against
 * the bONyc manager — no intent layer required because the relayer
 * doesn't need per-user attribution on the withdraw side (the inflight
 * Flow PDA already binds the originating wallet from the deposit-side
 * `claim_usdc` that opened the position).
 *
 * **Bridge context provider (deposit only).** The signed Wormhole
 * executor quote (165 bytes) and the NTT sub-account constellation
 * (`NttBridgeSubAccounts`, payee, fee mint/source/destination/config,
 * etc.) are not derivable from the session alone — they require live
 * Wormhole NTT route + executor relay calls. The hook accepts a
 * caller-supplied `bridgeContextProvider` thunk so the integration
 * surface stays explicit. Pass `null` to disable deposit (the form
 * will refuse to submit with a recognizable error).
 *
 * `lastSubmission` exposes signature + start time on success so callers
 * can attach a `useFlowStatus` watcher and persist the pending entry.
 * It's distinct from `status` (which resets to `idle` between
 * submissions) so the cross-chain watcher keeps tracking the latest
 * delivered tx after the local form resets.
 */

export type TransferKind = 'deposit' | 'withdraw'

const KIND_LABEL: Record<TransferKind, string> = {
  deposit: 'Deposit',
  withdraw: 'Withdraw',
}

export interface TransferSubmission {
  signature: string
  startedAt: number
  amount: bigint
  /**
   * Destination-ATA balance on FOGO captured **before** the user signed
   * the submit. `useFlowStatus` uses this as its delivery baseline so
   * concurrent deliveries from other tabs / prior bridges can't cause a
   * false-positive "delivered" toast for this flow. `null` only if the
   * pre-send read failed (rare RPC outage); the watcher then falls back
   * to its legacy capture-on-first-tick behaviour.
   */
  baselineBalance: bigint | null
}

/**
 * Caller-supplied resolver for the deposit-side wire pieces this hook
 * cannot synthesize on its own.
 *
 * Implementer responsibilities:
 *   1. Fetch a Wormhole executor signed quote (Solana-bound) for the
 *      requested `amount`. Must be exactly 165 bytes.
 *   2. Derive the FOGO USDC.s NTT sub-account constellation (manager
 *      config, peer, transceiver, custody, session authority, etc.)
 *      via Wormhole's NTT SDK helpers.
 *   3. Provide the intent message metadata (token symbols, fee token,
 *      fee amount, monotonic per-(intent_transfer, source-ATA-owner)
 *      nonce). Nonce must be fetched on-chain — derive PDA
 *      `["bridge_ntt_nonce", source_ata.owner]` under intent_transfer.
 *   4. Provide every top-level account the `bridge_ntt_tokens` ix
 *      requires (source ATA, intermediate ATA, mint, fee accounts,
 *      sponsor PDA, etc.).
 *   5. Tell us whether the destination ATA on Solana is missing, so we
 *      can flip `pay_destination_ata_rent` (executor will pre-fund the
 *      ATA at delivery for ~2_039_280 lamports of `msg_value`).
 *
 * The hook signs the message with the user's session wallet and
 * appends the resulting Ed25519 verifier ix in front of
 * `bridge_ntt_tokens`. The outbox-item keypair is generated here and
 * exposed as `outboxItem` so the caller's NTT sub-context derivation
 * can use the same pubkey.
 */
export interface DepositBridgeContext {
  signedQuoteBytes: Uint8Array
  payDestinationAtaRent: boolean
  /**
   * Optional address-lookup table to pass to `sendTransaction`. The
   * NTT manager publishes a LUT covering its standard account
   * constellation (config, peer, transceiver, custody, wormhole bridge
   * accounts, etc.) — without it, `bridge_ntt_tokens` can blow past the
   * 1232-byte legacy-tx limit. Withdraw doesn't need one because
   * `transfer_burn` references far fewer accounts.
   */
  addressLookupTable?: PublicKey
  intent: Omit<BuildBridgeOutIntentMessageParams, 'recipientAddress'>
  topLevel: {
    fromChainId: PublicKey
    intentTransferSetter: PublicKey
    source: PublicKey
    intermediateTokenAccount: PublicKey
    mint: PublicKey
    metadata: PublicKey | null
    expectedNttConfig: PublicKey
    nonce: PublicKey
    sponsor: PublicKey
    feeSource: PublicKey
    feeDestination: PublicKey
    feeMint: PublicKey
    feeMetadata: PublicKey | null
    feeConfig: PublicKey
  }
  ntt: NttBridgeSubAccounts
}

export type BridgeContextProvider = (params: {
  walletPublicKey: PublicKey
  recipientAddress: PublicKey
  amount: bigint
  outboxItem: PublicKey
}) => Promise<DepositBridgeContext>

interface UseFogoNttTransferOptions {
  /**
   * Required when `kind === 'deposit'`. Pass `null` to keep the deposit
   * UI mounted but non-submittable (useful while the caller wires
   * Wormhole quote/PDA derivation).
   */
  bridgeContextProvider?: BridgeContextProvider | null
}

export function useFogoNttTransfer(
  kind: TransferKind,
  sessionState: SessionState,
  options: UseFogoNttTransferOptions = {},
) {
  const [status, setStatus] = useState<TxStatus>(idle)
  const [lastSubmission, setLastSubmission] = useState<TransferSubmission | null>(null)
  const { fogoRpcUrl } = useSettings()

  const submit = async (amount: bigint) => {
    if (!isEstablished(sessionState) || amount <= 0n) {
      return
    }

    const startedAt = Date.now()
    setStatus(pending)
    // Snapshot destination-ATA balance BEFORE signing the submit so the
    // cross-chain watcher has a race-free baseline. Failures are
    // tolerated (`null`) — the watcher will fall back to capturing on
    // first poll, the legacy (race-prone but functional) behaviour.
    const baselineBalance = await readDestinationBalance(
      sessionState.walletPublicKey,
      kind,
      fogoRpcUrl,
    )
    try {
      const built = kind === 'deposit'
        ? await buildDepositIxs({
            sessionState,
            amount,
            provider: options.bridgeContextProvider,
          })
        : buildWithdrawIx({ sessionState, amount })
      const ixs = built.ixs
      const extraSigners = built.extraSigners
      const addressLookupTable = built.addressLookupTable

      // Route the bridge tx at Fogo Labs' generic `sessions` paymaster
      // under the permissive `Intent NTT Bridge` variation. That sponsor
      // (`47aX6R…`) carries a 774k FOGO buffer and accepts any
      // `bridge_ntt_tokens` ix shaped like the whitelisted variation, so
      // we pay nothing in FOGO native gas and the user pays the bridge
      // fee in USDC.s (deducted by intent_transfer's own fee path). The
      // per-call overrides flow through @fogo/sessions-sdk's
      // `sendToPaymaster(domain, ...)` in context.js:22.
      //
      // The custom union LUT is still mandatory for the deposit path —
      // without it the unrolled `bridge_ntt_tokens` ix exceeds the
      // 1232-byte legacy tx limit and the paymaster rejects with
      // HTTP 400.
      const sendOptions: {
        extraSigners: Keypair[]
        addressLookupTable?: string
        paymasterDomain?: string
        variation?: string
      } = { extraSigners }
      if (addressLookupTable) {
        sendOptions.addressLookupTable = addressLookupTable.toBase58()
      }
      if (kind === 'deposit') {
        sendOptions.paymasterDomain = FOGO_BRIDGE_PAYMASTER_DOMAIN
        sendOptions.variation = FOGO_BRIDGE_VARIATION
      }

      // TEMP DIAGNOSTIC removed (sponsor-collapse fix: see
      // depositContext.ts — bridge_ntt_tokens.sponsor is now the
      // sessions sponsor pubkey, so the paymaster rebuild stays under
      // the 1232 B legacy-tx limit).

      const result = await sessionState.sendTransaction(ixs, sendOptions)
      if (result.type === TransactionResultType.Failed) {
        const message = result.error instanceof Error
          ? result.error.message
          : typeof result.error === 'string'
            ? result.error
            : `${KIND_LABEL[kind]} transaction failed`
        setStatus(error(message))
        return
      }
      setStatus(success(result.signature))
      setLastSubmission({ signature: result.signature, startedAt, amount, baselineBalance })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : `${KIND_LABEL[kind]} failed`
      setStatus(error(message))
    }
  }

  return {
    status,
    submit,
    lastSubmission,
    reset: () => setStatus(idle),
  }
}

async function buildDepositIxs(args: {
  sessionState: Extract<SessionState, { walletPublicKey: PublicKey, payer: PublicKey }>
  amount: bigint
  provider: BridgeContextProvider | null | undefined
}): Promise<{
  ixs: TransactionInstruction[]
  extraSigners: Keypair[]
  addressLookupTable: PublicKey | undefined
}> {
  const { sessionState, amount, provider } = args
  if (!provider) {
    throw new Error(
      'Deposit not configured: pass a `bridgeContextProvider` to useFogoNttTransfer to enable submission.',
    )
  }

  const [recipientAddress] = findUserInboxAuthorityPda(
    sessionState.walletPublicKey,
    RELAYER_PROGRAM_ID,
  )

  const outboxItemKp = Keypair.generate()

  const ctx = await provider({
    walletPublicKey: sessionState.walletPublicKey,
    recipientAddress,
    amount,
    outboxItem: outboxItemKp.publicKey,
  })

  const message = buildBridgeOutIntentMessage({ ...ctx.intent, recipientAddress })
  // signMessage is the wallet-adapter contract; modern wallets (Phantom,
  // Backpack, Solflare) sign the message bytes verbatim and return only
  // the signature. The on-chain Ed25519 verifier ix carries the message
  // bytes alongside the signature, so we can reuse `message` for both.
  // TODO(ledger): some legacy ledger configurations require the FOGO
  // off-chain message prefix (`addLegacyOffchainMessagePrefixToMessage`).
  // Wire that in here if ledger-backed Phantom/Nightly users hit
  // signature-mismatch errors.
  const signature = await getSessionSignMessage(sessionState)(message)

  return {
    ixs: [
      // bridge_ntt_tokens unrolls into a deep CPI chain (intent_transfer
      // → ntt-with-executor → NTT manager → Wormhole core bridge →
      // executor program) plus two SPL transfers and an Ed25519 sysvar
      // read. Empirically lands around ~700k CU on mainnet; sessions-sdk's
      // reference `bridgeOut` requests 1.4M. Without an explicit limit
      // the runtime gives us 200k * num_ixs (≈400k here) and we abort
      // mid-CPI with `ProgramFailedToComplete` (no Custom code).
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      buildIntentVerifierIx(sessionState.walletPublicKey, signature, message),
      buildBridgeNttTokensIx({
        ...ctx.topLevel,
        ntt: ctx.ntt,
        signedQuoteBytes: ctx.signedQuoteBytes,
        payDestinationAtaRent: ctx.payDestinationAtaRent,
      }),
    ],
    extraSigners: [outboxItemKp],
    addressLookupTable: ctx.addressLookupTable,
  }
}

function buildWithdrawIx(args: {
  sessionState: Extract<SessionState, { walletPublicKey: PublicKey }>
  amount: bigint
}): {
  ixs: TransactionInstruction[]
  extraSigners: Keypair[]
  addressLookupTable: PublicKey | undefined
} {
  const { sessionState, amount } = args
  const [recipientOnSolana] = findAuthorityPda(RELAYER_PROGRAM_ID)
  const outboxItemKp = Keypair.generate()
  const ix = buildFogoNttWithdrawIx({
    payer: sessionState.walletPublicKey,
    nttManagerProgramId: FOGO_BONYC_NTT_MANAGER_ID,
    mint: BONYC_MINT,
    outboxItem: outboxItemKp.publicKey,
    amount,
    recipientOnSolana,
  })
  return {
    ixs: [ix],
    extraSigners: [outboxItemKp],
    addressLookupTable: undefined,
  }
}

/**
 * Isolates the `solanaWallet` cast that bypasses sessions-sdk-react's
 * declared `SessionState` shape. The SDK doesn't surface `signMessage`
 * on its public types, but every wallet adapter it integrates with
 * (Phantom, Backpack, Solflare) implements it. Centralizing the cast
 * keeps the type hole in one named place rather than scattered through
 * the ix builders.
 */
function getSessionSignMessage(
  sessionState: SessionState,
): (message: Uint8Array) => Promise<Uint8Array> {
  const wallet = (sessionState as { solanaWallet: { signMessage: (m: Uint8Array) => Promise<Uint8Array> } }).solanaWallet
  return wallet.signMessage.bind(wallet)
}

// Pre-send destination-balance snapshot. The mint depends on `kind`:
// deposit credits bONyc back, withdraw credits USDC.s. Returning `null`
// on RPC failure is intentional — the watcher falls back to its
// capture-on-first-tick path so a transient outage doesn't block the
// submit entirely.
async function readDestinationBalance(
  walletPublicKey: PublicKey,
  kind: TransferKind,
  fogoRpcUrl: string,
): Promise<bigint | null> {
  try {
    const mint = kind === 'deposit' ? BONYC_MINT : USDC_S_MINT
    const ata = getAssociatedTokenAddressSync(mint, walletPublicKey)
    const result = await getFogoConnection(fogoRpcUrl).getTokenAccountBalance(ata, 'confirmed')
    return BigInt(result.value.amount)
  } catch {
    // ATA likely doesn't exist yet (first-time deposit / fresh wallet).
    // Treat as zero so the watcher's `balance > baseline` check still
    // fires correctly when the destination ATA gets created + funded.
    return 0n
  }
}
