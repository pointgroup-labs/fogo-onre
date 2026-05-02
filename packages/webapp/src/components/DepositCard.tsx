'use client'

import { isEstablished, useSession } from '@fogo/sessions-sdk-react'
import { useState } from 'react'
import AmountInput from '@/components/AmountInput'
import StatusLine from '@/components/StatusLine'
import { useDeposit } from '@/hooks/useDeposit'
import { USDC_S_DECIMALS } from '@/lib/config'
import { parseAmount } from '@/lib/tx'

export default function DepositCard() {
  const sessionState = useSession()
  const { status, deposit } = useDeposit(sessionState)
  const [input, setInput] = useState('')

  const parsed = parseAmount(input, USDC_S_DECIMALS)
  const ready = isEstablished(sessionState) && parsed !== null && parsed > 0n
  const submitting = status.kind === 'pending'

  const onSubmit = async () => {
    if (!ready || parsed === null) {
      return
    }
    await deposit(parsed)
  }

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-950 p-6 flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold">Deposit</h2>
        <p className="text-sm text-neutral-400">
          Send USDC.s. You receive bONyc once the cross-chain flow settles (a few minutes).
        </p>
      </div>
      <AmountInput
        value={input}
        onChange={setInput}
        symbol="USDC.s"
        disabled={submitting}
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!ready || submitting}
        className="w-full rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
      >
        {submitting ? 'Depositing…' : 'Deposit'}
      </button>
      <StatusLine status={status} />
    </section>
  )
}
