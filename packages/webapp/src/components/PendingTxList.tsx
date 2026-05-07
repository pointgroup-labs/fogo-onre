'use client'

import type { PendingTx } from '@/store/pending-txs'
import { useEffect, useState } from 'react'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS } from '@/constants'
import { usePendingTxsStore } from '@/store/pending-txs'
import { fogoTxUrl, shortSig, wormholeTxUrl } from '@/utils/explorers'
import { formatAmount } from '@/utils/transfer'

/**
 * Reload-resilient log of in-flight cross-chain transactions.
 * Subscribes directly to `usePendingTxsStore` — no props.
 *
 * Elapsed-time labels update every 30s via a single shared
 * `useNowMinute()` ticker driven at the list level so all rows
 * re-render together (cheaper than per-row intervals).
 */
export default function PendingTxList() {
  const txs = usePendingTxsStore(s => s.txs)
  const remove = usePendingTxsStore(s => s.remove)
  const now = useNowMinute()

  if (txs.length === 0) {
    return null
  }
  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Recent transactions</h3>
        <span className="text-xs text-neutral-500">{txs.length}</span>
      </div>
      <ul className="flex flex-col gap-2">
        {txs.map(tx => (
          <PendingTxRow key={tx.signature} tx={tx} now={now} onDismiss={remove} />
        ))}
      </ul>
    </section>
  )
}

function PendingTxRow({
  tx,
  now,
  onDismiss,
}: {
  tx: PendingTx
  now: number
  onDismiss: (sig: string) => void
}) {
  // Deposit burns USDC.s (6 dp). Withdraw burns ONyc (9 dp).
  const decimals = tx.kind === 'deposit' ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const symbol = tx.kind === 'deposit' ? 'USDC.s' : 'ONyc'
  const amount = (() => {
    try {
      return formatAmount(BigInt(tx.amount), decimals)
    } catch {
      return '?'
    }
  })()
  const elapsedMin = Math.max(1, Math.floor((now - tx.submittedAt) / 60_000))
  const stateLabel = tx.delivered ? 'delivered' : `${elapsedMin}m ago`
  const stateClass = tx.delivered ? 'text-emerald-400' : 'text-amber-400'

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-neutral-800/60 bg-neutral-900/40 px-3 py-2 text-xs">
      <div className="flex flex-col gap-0.5 overflow-hidden">
        <div className="flex items-baseline gap-2">
          <span className="font-medium uppercase tracking-wide text-neutral-300">{tx.kind}</span>
          <span className="font-mono text-neutral-200">{`${amount} ${symbol}`}</span>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-neutral-500">
          <a
            href={fogoTxUrl(tx.signature)}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate font-mono underline decoration-dotted underline-offset-2 hover:text-neutral-300"
          >
            {shortSig(tx.signature)}
          </a>
          <span className="text-neutral-700">·</span>
          <a
            href={wormholeTxUrl(tx.signature)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-dotted underline-offset-2 hover:text-neutral-300"
          >
            VAA
          </a>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <span className={stateClass}>{stateLabel}</span>
        <button
          type="button"
          onClick={() => onDismiss(tx.signature)}
          className="text-neutral-500 hover:text-neutral-200"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </li>
  )
}

function useNowMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}
