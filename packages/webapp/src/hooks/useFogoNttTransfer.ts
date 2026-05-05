'use client'

import type { SessionState } from '@fogo/sessions-sdk-react'
import type { TransactionInstruction } from '@solana/web3.js'
import type { TxStatus } from '@/utils/transfer'
import {
  buildFogoNttDepositIx,
  buildFogoNttWithdrawIx,
  findAuthorityPda,
  RELAYER_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { isEstablished, TransactionResultType } from '@fogo/sessions-sdk-react'
import { Keypair, PublicKey } from '@solana/web3.js'
import { useState } from 'react'
import {
  BONYC_MINT,
  FOGO_BONYC_NTT_MANAGER_ID,
  FOGO_USDC_S_NTT_MANAGER_ID,
  USDC_S_MINT,
} from '@/constants'
import { error, idle, pending, success } from '@/utils/transfer'

/**
 * Unified FOGO-side NTT `transfer_burn` hook covering both deposit
 * (USDC.s burn → Solana relayer authority PDA) and withdraw (bONyc burn →
 * same authority PDA). The previous shape had two near-identical hooks
 * — collapsed here so future fixes (error mapping, signer extraction,
 * paymaster handling) only need to land in one file.
 *
 * The originator's FOGO wallet rides as `NttManagerMessage.sender`
 * automatically; no custom payload is needed. The Solana side is then
 * cranked permissionlessly:
 *   deposit:  claim_usdc → swap_usdc_to_onyc → lock_onyc → bONyc to user.
 *   withdraw: unlock_onyc → request_redemption_onyc → (OnRe fulfils async)
 *             → claim_redemption_usdc → send_usdc_to_user → USDC.s to user.
 *
 * `lastSubmission` exposes signature + start time on success so callers
 * can attach a `useFlowStatus` watcher and persist the pending entry.
 * It's distinct from `status` (which resets to `idle` between
 * submissions) so the cross-chain watcher keeps tracking the latest
 * delivered tx after the local form resets.
 */

export type TransferKind = 'deposit' | 'withdraw'

export interface TransferSubmission {
  signature: string
  startedAt: number
  amount: bigint
}

interface KindConfig {
  mint: PublicKey
  managerProgramId: PublicKey
  buildIx: (params: {
    payer: PublicKey
    nttManagerProgramId: PublicKey
    mint: PublicKey
    outboxItem: PublicKey
    amount: bigint
    recipientOnSolana: PublicKey
  }) => TransactionInstruction
  failureLabel: string
}

const KIND_CONFIG: Record<TransferKind, KindConfig> = {
  deposit: {
    mint: USDC_S_MINT,
    managerProgramId: FOGO_USDC_S_NTT_MANAGER_ID,
    buildIx: buildFogoNttDepositIx,
    failureLabel: 'Deposit',
  },
  withdraw: {
    mint: BONYC_MINT,
    managerProgramId: FOGO_BONYC_NTT_MANAGER_ID,
    buildIx: buildFogoNttWithdrawIx,
    failureLabel: 'Withdraw',
  },
}

export function useFogoNttTransfer(kind: TransferKind, sessionState: SessionState) {
  const [status, setStatus] = useState<TxStatus>(idle)
  const [lastSubmission, setLastSubmission] = useState<TransferSubmission | null>(null)
  const config = KIND_CONFIG[kind]

  const submit = async (amount: bigint) => {
    if (!isEstablished(sessionState) || amount <= 0n) {
      return
    }

    const startedAt = Date.now()
    setStatus(pending)
    try {
      const [recipientOnSolana] = findAuthorityPda(RELAYER_PROGRAM_ID)
      const outboxItemKp = Keypair.generate()
      const ix = config.buildIx({
        payer: sessionState.walletPublicKey,
        nttManagerProgramId: config.managerProgramId,
        mint: config.mint,
        outboxItem: outboxItemKp.publicKey,
        amount,
        recipientOnSolana,
      })
      const result = await sessionState.sendTransaction([ix], {
        extraSigners: [outboxItemKp],
      })
      if (result.type === TransactionResultType.Failed) {
        const message = result.error instanceof Error
          ? result.error.message
          : typeof result.error === 'string'
            ? result.error
            : `${config.failureLabel} transaction failed`
        setStatus(error(message))
        return
      }
      setStatus(success(result.signature))
      setLastSubmission({ signature: result.signature, startedAt, amount })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : `${config.failureLabel} failed`
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
