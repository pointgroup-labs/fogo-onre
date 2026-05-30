'use client'

import type { BridgeContextProvider } from '@/lib/bridge/context'
import type { FlowKind, PersistedFlowStatus } from '@/lib/flow-status/types'
import {
  buildBridgeNttTokensIx,
  buildBridgeOutIntentMessage,
  buildIntentVerifierIx,
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
} from '@/constants'
import { findFeeConfigPda, readBridgeTransferFee } from '@/lib/bridge/feeConfig'
import { addFlow, pendingWithdrawExists } from '@/lib/flow-status/store'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'
import { fogoTxUrl, shortSig } from '@/utils/explorers'

/**
 * Central submit hook wrapping the full deposit/withdraw flow under a
 * single TanStack mutation. Both legs share one on-chain shape: an
 * Ed25519 intent verifier ix + `intent_transfer.bridge_ntt_tokens`
 * routed at OUR paymaster lane so the bridge fee accrues to OnRe. The
 * leg-specific wiring (mint, NTT manager, fee token) is resolved by the
 * caller-supplied `bridgeContextProvider`.
 *
 * Two-layer withdraw guard:
 *   1. Caller-owned: parent component disables submit while
 *      `mutation.isPending` is true.
 *   2. Cache guard (this layer): `pendingWithdrawExists(qc)` runs
 *      inside `mutationFn` so retries re-evaluate freshly.
 */

export interface UseTransferMutationOptions {
  /**
   * Resolves the leg's bridge wiring (Wormhole quote + NTT
   * sub-accounts). Pass `null` to keep the form mounted but
   * non-submittable while the caller wires the provider.
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
        // Friendlier than "Withdraw already in flight" — explains *why*
        // it's blocked and what the user can do (the journal is
        // self-clearing past the 2h stuck-pending window in
        // `pendingWithdrawExists`, but they shouldn't have to read
        // source to figure that out).
        throw new Error(
          'A previous redeem is still in flight. Wait for it to finish or check Bridge history.',
        )
      }

      const amount = parseAmountStrict(args.amountStr, args.decimals)
      if (amount <= 0n) {
        throw new Error('Amount must be greater than zero')
      }

      const destOwner = new PublicKey(args.destOwnerB58)
      const destMint = new PublicKey(args.destMintB58)
      const baselineDestBalance = await readDestinationBalance(destOwner, destMint, fogoRpcUrl)

      // Cache-warm the bridge-fee preview so the form's gate doesn't
      // race the next refetch. Withdraw skipped: its fee row isn't shown.
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

      const built = await buildIntentBridgeIxs({
        sessionState,
        amount,
        provider: bridgeContextProvider,
      })

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
      const signature = result.signature

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
        status.kind === 'deposit' ? 'Deposit submitted' : 'Redeem submitted',
        {
          id: status.flowId,
          description: `Tx ${shortSig(status.signature)}`,
          action: {
            label: 'Explore',
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
// yet on a fresh wallet).
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

/**
 * Builds the shared intent-bridge tx for either leg: an Ed25519 verifier
 * ix over the signed intent message + `bridge_ntt_tokens`, both pinned
 * to the per-user inbox PDA on Solana. The provider supplies the
 * leg-specific Wormhole quote and NTT sub-accounts.
 */
async function buildIntentBridgeIxs(args: {
  sessionState: Extract<ReturnType<typeof useSession>, { walletPublicKey: PublicKey, payer: PublicKey }>
  amount: bigint
  provider: BridgeContextProvider | null | undefined
}) {
  const { sessionState, amount, provider } = args
  if (!provider) {
    throw new Error(
      'Bridge not configured: pass a `bridgeContextProvider` to useTransferMutation to enable submission.',
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
