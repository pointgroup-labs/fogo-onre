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
  findUserInboxAuthorityPda,
  RELAYER_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { isEstablished, TransactionResultType, useSession } from '@fogo/sessions-sdk-react'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ComputeBudgetProgram, Keypair, PublicKey } from '@solana/web3.js'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  FOGO_BRIDGE_PAYMASTER_DOMAIN,
  FOGO_BRIDGE_VARIATION,
  FOGO_ONYC_MINT,
  FOGO_ONYC_NTT_MANAGER_ID,
} from '@/constants'
import { findFeeConfigPda, readBridgeTransferFee } from '@/lib/bridge/feeConfig'
import { addFlow, pendingWithdrawExists } from '@/lib/flow-status/store'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

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

      const sendOptions: {
        extraSigners: Keypair[]
        addressLookupTable?: string
        paymasterDomain?: string
        variation?: string
      } = { extraSigners: built.extraSigners }
      if (built.addressLookupTable) {
        sendOptions.addressLookupTable = built.addressLookupTable.toBase58()
      }
      if (args.kind === 'deposit') {
        sendOptions.paymasterDomain = FOGO_BRIDGE_PAYMASTER_DOMAIN
        sendOptions.variation = FOGO_BRIDGE_VARIATION
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

      // Signatures are unique per landed tx, so reusing the signature
      // as flowId gives a deterministic key that survives reload
      // without an additional derivation table.
      const flowId = result.signature
      const persisted: PersistedFlowStatus = {
        flowId,
        kind: args.kind,
        signature: result.signature,
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
        { id: status.flowId, description: `Tx ${status.signature.slice(0, 8)}…` },
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
  const ix = buildFogoNttWithdrawIx({
    payer: sessionState.walletPublicKey,
    nttManagerProgramId: FOGO_ONYC_NTT_MANAGER_ID,
    mint: FOGO_ONYC_MINT,
    outboxItem: outboxItemKp.publicKey,
    amount,
    recipientOnSolana,
  })
  return {
    ixs: [ix],
    extraSigners: [outboxItemKp],
    addressLookupTable: undefined as PublicKey | undefined,
  }
}
