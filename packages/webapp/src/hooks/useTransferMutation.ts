'use client'

import type {
  BridgeContextProvider,
} from '@/hooks/useFogoNttTransfer'
import type { FlowKind, PersistedFlowStatus } from '@/lib/flow-status/types'
import {
  buildBridgeNttTokensIx,
  buildBridgeOutIntentMessage,
  buildFogoNttWithdrawIx,
  buildIntentVerifierIx,
  findAuthorityPda,
  findSessionAuthorityPda,
  findUserInboxAuthorityPda,
  nttTransferArgsHash,
  RELAYER_PROGRAM_ID,
  SOLANA_WORMHOLE_CHAIN_ID,
} from '@fogo-onre/sdk'
import { isEstablished, TransactionResultType, useSession } from '@fogo/sessions-sdk-react'
import { createApproveCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  FOGO_BRIDGE_PAYMASTER_DOMAIN,
  FOGO_BRIDGE_VARIATION,
  FOGO_ONYC_DECIMALS,
  FOGO_ONYC_MINT,
  FOGO_ONYC_NTT_MANAGER_ID,
} from '@/constants'
import { findFeeConfigPda, readBridgeTransferFee } from '@/lib/bridge/feeConfig'
import { buildFogoReleaseOnycOutboundIx } from '@/lib/bridge/releaseFogoOutbound'
import { addFlow, pendingWithdrawExists } from '@/lib/flow-status/store'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'
import { fogoTxUrl, shortSig } from '@/utils/explorers'

/**
 * Central submit hook wrapping the full deposit/withdraw flow under a
 * single TanStack mutation. Supersedes `useFogoNttTransfer`'s ad-hoc
 * `useState` lifecycle: the mutation surface gives callers
 * `mutate/mutateAsync`, `isPending`, and uniform error propagation while
 * the on-chain CPI semantics (intent verifier + `bridge_ntt_tokens` for
 * deposit, raw `transfer_burn` for withdraw) are mirrored verbatim from
 * the legacy hook.
 *
 * Three-layer withdraw guard:
 *   1. Caller-owned: parent component disables submit while
 *      `mutation.isPending` is true (T15 wires this).
 *   2. Cache guard (this layer): `pendingWithdrawExists(qc)` runs
 *      inside* `mutationFn` so retries re-evaluate freshly.
 *   3. On-chain: relayer's `RedemptionTracker` PDA. Errors from this
 *      layer are *not* swallowed — they bubble up through `onError`.
 */

export interface UseTransferMutationOptions {
  /**
   * Required for deposits. Pass `null` to keep the form mounted but
   * non-submittable while the caller wires the Wormhole quote / NTT
   * sub-account derivation.
   */
  bridgeContextProvider?: BridgeContextProvider | null
}

export interface SubmitArgs {
  kind: FlowKind
  amountStr: string
  decimals: number
  mintB58: string
  /** FOGO-side destination ATA owner (typically the user wallet). */
  destOwnerB58: string
  /** FOGO-side destination mint (ONyc for deposit, USDC.s for withdraw). */
  destMintB58: string
}

export function useTransferMutation(options: UseTransferMutationOptions = {}) {
  const qc = useQueryClient()
  const sessionState = useSession()
  const { fogoRpcUrl } = useSettings()
  const { bridgeContextProvider } = options

  return useMutation({
    mutationFn: async (args: SubmitArgs): Promise<PersistedFlowStatus> => {
      if (!isEstablished(sessionState)) {
        throw new Error('Wallet not connected')
      }
      if (args.kind === 'withdraw' && pendingWithdrawExists(qc)) {
        throw new Error('Withdraw already in flight')
      }

      const amount = parseAmountStrict(args.amountStr, args.decimals)
      if (amount <= 0n) {
        throw new Error('Amount must be greater than zero')
      }

      const destOwner = new PublicKey(args.destOwnerB58)
      const destMint = new PublicKey(args.destMintB58)
      const baselineDestBalance = await readDestinationBalance(destOwner, destMint, fogoRpcUrl)

      // Cache-warm the bridge-fee preview so the form's gate doesn't
      // race the next refetch. Withdraw skipped: the on-chain withdraw
      // path doesn't deduct via `FeeConfig.bridge_transfer_fee`.
      if (args.kind === 'deposit') {
        await qc.fetchQuery({
          queryKey: ['bridge-fee', fogoRpcUrl] as const,
          staleTime: 30_000,
          queryFn: async () => {
            const feeConfig = findFeeConfigPda(new PublicKey(args.mintB58))
            return readBridgeTransferFee(getFogoConnection(fogoRpcUrl), feeConfig)
          },
        })
      }

      const built = args.kind === 'deposit'
        ? await buildDepositIxs({ sessionState, amount, provider: bridgeContextProvider })
        : buildWithdrawIxs({ sessionState, amount })

      let signature: string
      if (args.kind === 'withdraw') {
        // Withdraw bypasses the session paymaster: the raw NTT
        // `transfer_burn` ix shape doesn't match any registered
        // paymaster variation, so the `'sessions'` policy gate rejects
        // the ephemeral `outboxItem` keypair as an unauthorized signer
        // ("Missing or invalid signature for account <outboxItem>").
        // Until Fogo Labs registers `FeeConfig(ONyc)` (which would let
        // withdraw route through `intent_transfer.bridge_ntt_tokens`
        // and ride the existing `'Intent NTT Bridge'` variation), the
        // user's main wallet pays gas directly. UX cost: one extra
        // wallet popup on withdraw — acceptable on a deliberate,
        // higher-stakes action.
        signature = await sendWithMainWallet({
          sessionState,
          ixs: built.ixs,
          extraSigners: built.extraSigners,
          fogoRpcUrl,
        })
      } else {
        const sendOptions: {
          extraSigners: Keypair[]
          addressLookupTable?: string
          paymasterDomain?: string
          variation?: string
        } = {
          extraSigners: built.extraSigners,
          paymasterDomain: FOGO_BRIDGE_PAYMASTER_DOMAIN,
          variation: FOGO_BRIDGE_VARIATION,
        }
        if (built.addressLookupTable) {
          sendOptions.addressLookupTable = built.addressLookupTable.toBase58()
        }
        const result = await sessionState.sendTransaction(built.ixs, sendOptions)
        if (result.type === TransactionResultType.Failed) {
          const message = result.error instanceof Error
            ? result.error.message
            : typeof result.error === 'string'
              ? result.error
              : 'Transaction failed'
          throw new Error(message)
        }
        signature = result.signature
      }

      // Signatures are unique per landed tx, so reusing the signature
      // as flowId gives a deterministic key that survives reload
      // without an additional derivation table.
      const flowId = signature
      const persisted: PersistedFlowStatus = {
        flowId,
        kind: args.kind,
        signature,
        ownerB58: sessionState.walletPublicKey.toBase58(),
        mintB58: args.mintB58,
        amountStr: args.amountStr,
        startedAt: Date.now(),
        baselineDestBalanceStr: baselineDestBalance.toString(),
        status: 'pending',
        notified: false,
        lastPolledAt: 0,
      }
      addFlow(qc, persisted)
      qc.invalidateQueries({ queryKey: ['balances'] })
      return persisted
    },
    onSuccess: (status) => {
      toast.success(
        status.kind === 'deposit' ? 'Deposit submitted' : 'Withdraw submitted',
        {
          id: status.flowId,
          description: `Tx ${shortSig(status.signature)}`,
          action: {
            label: 'Explorer',
            onClick: () => {
              window.open(fogoTxUrl(status.signature), '_blank', 'noopener,noreferrer')
            },
          },
        },
      )
    },
    onError: (err) => {
      toast.error('Transaction failed', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    },
  })
}

function parseAmountStrict(amountStr: string, decimals: number): bigint {
  if (!/^\d*(?:\.\d*)?$/.test(amountStr) || amountStr === '') {
    throw new Error('Invalid amount')
  }
  const [whole, fraction = ''] = amountStr.split('.')
  if (fraction.length > decimals) {
    throw new Error(`Amount exceeds ${decimals} decimals`)
  }
  const padded = fraction.padEnd(decimals, '0')
  return BigInt(`${whole || '0'}${padded}`)
}

// Fall back to 0n on any RPC failure (most commonly: ATA doesn't exist
// yet on a fresh wallet). Matches `useFogoNttTransfer.readDestinationBalance`.
async function readDestinationBalance(
  destOwner: PublicKey,
  destMint: PublicKey,
  fogoRpcUrl: string,
): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(destMint, destOwner)
    const result = await getFogoConnection(fogoRpcUrl).getTokenAccountBalance(ata, 'confirmed')
    return BigInt(result.value.amount)
  } catch {
    return 0n
  }
}

// Submits a tx with the user's main (Solana) wallet as fee payer,
// bypassing the session paymaster. Used for withdraw because the raw
// NTT `transfer_burn` shape isn't covered by any registered paymaster
// variation; the session-paymaster policy gate rejects the ephemeral
// `outboxItem` keypair as an unauthorized signer regardless of the
// signature being mathematically valid.
async function sendWithMainWallet(args: {
  sessionState: Extract<ReturnType<typeof useSession>, { walletPublicKey: PublicKey }>
  ixs: TransactionInstruction[]
  extraSigners: Keypair[]
  fogoRpcUrl: string
}): Promise<string> {
  const { sessionState, ixs, extraSigners, fogoRpcUrl } = args
  const wallet = (sessionState as unknown as {
    solanaWallet: {
      signTransaction: <T extends VersionedTransaction>(tx: T) => Promise<T>
    }
  }).solanaWallet
  const conn = getFogoConnection(fogoRpcUrl)
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: sessionState.walletPublicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  if (extraSigners.length > 0) {
    tx.sign(extraSigners)
  }
  const signed = await wallet.signTransaction(tx)
  const signature = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false })
  const conf = await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
  if (conf.value.err !== null) {
    throw new Error(`Withdraw transaction failed: ${JSON.stringify(conf.value.err)}`)
  }
  return signature
}

// Mirrors `useFogoNttTransfer.buildDepositIxs` — kept private here so
// the legacy hook stays the lockstep reference until T15 retires it.
async function buildDepositIxs(args: {
  sessionState: Extract<ReturnType<typeof useSession>, { walletPublicKey: PublicKey, payer: PublicKey }>
  amount: bigint
  provider: BridgeContextProvider | null | undefined
}) {
  const { sessionState, amount, provider } = args
  if (!provider) {
    throw new Error(
      'Deposit not configured: pass a `bridgeContextProvider` to useTransferMutation to enable submission.',
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
  const wallet = (sessionState as { solanaWallet: { signMessage: (m: Uint8Array) => Promise<Uint8Array> } }).solanaWallet
  const signature = await wallet.signMessage(message)

  return {
    ixs: [
      // ~700k CU empirically; runtime default of 200k * num_ixs is
      // insufficient for the deep CPI chain.
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

function buildWithdrawIxs(args: {
  sessionState: Extract<ReturnType<typeof useSession>, { walletPublicKey: PublicKey }>
  amount: bigint
}) {
  const { sessionState, amount } = args
  const [recipientOnSolana] = findAuthorityPda(RELAYER_PROGRAM_ID)
  const outboxItemKp = Keypair.generate()
  // NTT v1 `transfer_burn` invokes SPL `TransferChecked` from the
  // user's ATA into the manager's custody, with a `session_authority`
  // PDA as the spend authority. That PDA isn't the ATA owner, so the
  // ATA owner (the user wallet) must first approve the PDA as a
  // delegate for `amount`. Without this approve, the Token program
  // returns `OwnerMismatch` (custom error 0x4) at the TransferChecked
  // CPI. Deposit doesn't need this step because `bridge_ntt_tokens`
  // runs the approve internally, gated on the intent verifier's
  // signed-message proof.
  const transferArgsHash = nttTransferArgsHash({
    amount,
    recipientChain: SOLANA_WORMHOLE_CHAIN_ID,
    recipientAddress: recipientOnSolana.toBuffer(),
    shouldQueue: false,
  })
  const [sessionAuthorityPda] = findSessionAuthorityPda(
    sessionState.walletPublicKey,
    transferArgsHash,
    FOGO_ONYC_NTT_MANAGER_ID,
  )
  const userAta = getAssociatedTokenAddressSync(
    FOGO_ONYC_MINT,
    sessionState.walletPublicKey,
  )
  const approveIx = createApproveCheckedInstruction(
    userAta,
    FOGO_ONYC_MINT,
    sessionAuthorityPda,
    sessionState.walletPublicKey,
    amount,
    FOGO_ONYC_DECIMALS,
  )
  const transferBurnIx = buildFogoNttWithdrawIx({
    payer: sessionState.walletPublicKey,
    nttManagerProgramId: FOGO_ONYC_NTT_MANAGER_ID,
    mint: FOGO_ONYC_MINT,
    outboxItem: outboxItemKp.publicKey,
    amount,
    recipientOnSolana,
  })
  // NTT v1 splits outbound into stage + publish: `transfer_burn` only
  // creates the OutboxItem PDA, it does NOT call wormhole_core
  // post_message. Without an explicit `release_wormhole_outbound`
  // here, the burn lands but no VAA ever appears — the user's funds
  // get stuck in custody on FOGO and the Solana side has nothing to
  // redeem. Deposit hides this split inside
  // `intent_transfer.bridge_ntt_tokens`; withdraw must do it manually
  // until `FeeConfig(ONyc)` is registered with intent_transfer.
  const releaseIx = buildFogoReleaseOnycOutboundIx({
    payer: sessionState.walletPublicKey,
    outboxItem: outboxItemKp.publicKey,
  })
  return {
    ixs: [approveIx, transferBurnIx, releaseIx],
    extraSigners: [outboxItemKp],
    addressLookupTable: undefined as PublicKey | undefined,
  }
}
