'use client'

import type { SessionState } from '@fogo/sessions-sdk-react'
import { isEstablished, TransactionResultType } from '@fogo/sessions-sdk-react'
import { useState } from 'react'
import { error, idle, pending, success, type TxStatus } from '@/lib/tx'

/**
 * Builds and sends the FOGO-side withdraw transaction:
 * an NTT transfer of bONyc back to Solana, addressed to the relayer's
 * redeemer authority, with the withdraw payload attached.
 *
 * The Solana side is then cranked permissionlessly:
 *   unlock_onyc -> request_redemption_onyc -> (OnRe admin fulfills async)
 *   -> claim_redemption_usdc -> send_usdc_to_user -> USDC.s lands on the user.
 */
export function useWithdraw(sessionState: SessionState) {
  const [status, setStatus] = useState<TxStatus>(idle)

  const withdraw = async (amount: bigint) => {
    if (!isEstablished(sessionState) || amount <= 0n) {
      return
    }

    setStatus(pending)
    try {
      // TODO: build the FOGO NTT transfer instruction once
      // @fogo-onre/sdk exposes a FOGO-side helper, e.g.:
      //   const ix = buildFogoNttWithdrawIx({
      //     payer: sessionState.walletPublicKey,
      //     amount,
      //     bonycMint: BONYC_MINT,
      //     recipient: REDEEMER_AUTHORITY_PDA,
      //     payload: encodeWithdrawPayload({ fogoRecipient: sessionState.walletPublicKey }),
      //   })
      //   const res = await sessionState.sendTransaction([ix])
      throw new Error('Withdraw transaction builder not yet wired — see SDK TODO')
    }
    catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Withdraw failed'
      setStatus(error(message))
      return
    }
  }

  void TransactionResultType
  void success

  return { status, withdraw, reset: () => setStatus(idle) }
}
