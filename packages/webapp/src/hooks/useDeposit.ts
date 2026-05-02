'use client'

import type { SessionState } from '@fogo/sessions-sdk-react'
import { isEstablished, TransactionResultType } from '@fogo/sessions-sdk-react'
import { useState } from 'react'
import { error, idle, pending, success, type TxStatus } from '@/lib/tx'

/**
 * Builds and sends the FOGO-side deposit transaction:
 * a Wormhole Gateway transfer of USDC.s from the user to the relayer's
 * redeemer authority on Solana, with the deposit payload attached.
 *
 * The Solana side is then cranked permissionlessly:
 *   claim_usdc -> swap_usdc_to_onyc -> lock_onyc -> bONyc lands on the user.
 */
export function useDeposit(sessionState: SessionState) {
  const [status, setStatus] = useState<TxStatus>(idle)

  const deposit = async (amount: bigint) => {
    if (!isEstablished(sessionState) || amount <= 0n) {
      return
    }

    setStatus(pending)
    try {
      // TODO: build the FOGO Gateway transfer instruction once
      // @fogo-onre/sdk exposes a FOGO-side helper, e.g.:
      //   const ix = buildFogoGatewayDepositIx({
      //     payer: sessionState.walletPublicKey,
      //     amount,
      //     usdcSMint: USDC_S_MINT,
      //     // Recipient PDA on Solana: relayer's redeemer authority
      //     recipient: REDEEMER_AUTHORITY_PDA,
      //     payload: encodeDepositPayload({ fogoSender: sessionState.walletPublicKey }),
      //   })
      //   const res = await sessionState.sendTransaction([ix])
      throw new Error('Deposit transaction builder not yet wired — see SDK TODO')
    }
    catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Deposit failed'
      setStatus(error(message))
      return
    }
  }

  // Suppress unused-import lint until wiring is complete.
  void TransactionResultType
  void success

  return { status, deposit, reset: () => setStatus(idle) }
}
