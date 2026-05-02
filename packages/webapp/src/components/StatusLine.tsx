'use client'

import type { TxStatus } from '@/lib/tx'

interface StatusLineProps {
  status: TxStatus
}

export default function StatusLine({ status }: StatusLineProps) {
  if (status.kind === 'idle') {
    return null
  }
  if (status.kind === 'pending') {
    return <p className="text-sm text-neutral-400">Submitting transaction…</p>
  }
  if (status.kind === 'success') {
    return (
      <p className="text-sm text-emerald-400 break-all">
        Sent. Signature:
        {' '}
        <span className="font-mono">{status.signature}</span>
      </p>
    )
  }
  return <p className="text-sm text-red-400">{status.message}</p>
}
