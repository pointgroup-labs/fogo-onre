'use client'

import type { TxDetail } from './use-tx-data'
import { Check, LifeBuoy, Link2 } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { dismissBridge } from '@/lib/bridgeHistory/dismissed'

interface ActionsProps {
  detail: TxDetail
}

/**
 * User-affordance panel. Three actions, each gated on whether it's
 * currently meaningful:
 *   - Share link: always available; copies a deep-link to this page.
 *   - Mark delivered: only when the action is pending AND owner-locally
 *     persisted (action exists in history). Manual dismissal is a
 *     cosmetic, per-device override — see dismissed.ts for rationale.
 *   - Need help: always available; opens the GitHub issues page in a
 *     new tab. Cheap escape hatch; protocol has no in-product support.
 *
 * We intentionally don't include "Retry" or "Cancel" — both are
 * meaningless on a cross-chain bridge from the user's side. The
 * cranker drives delivery autonomously; once submitted, the user has
 * nothing to retry.
 */
export function Actions({ detail }: ActionsProps) {
  const { action, signature } = detail
  const delivered = action?.status === 'delivered'
    || action?.manuallyDismissed === true
    || detail.flow?.phase === 'delivered'
  const canMarkDelivered = !delivered && action !== null

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 px-5">
        <h2 className="text-sm font-semibold tracking-tight">Actions</h2>
        <CopyLinkAction signature={signature} />
        {canMarkDelivered && <MarkDeliveredAction signature={signature} />}
        <HelpAction signature={signature} />
      </CardContent>
    </Card>
  )
}

function CopyLinkAction({ signature }: { signature: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    // window.location.origin keeps the share URL on whatever host the
    // user is currently on (mainnet / staging / localhost). No env
    // lookup needed; this is always correct.
    const url = `${window.location.origin}/tx?signature=${signature}`
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(setCopied, 1500, false)
    } catch {
      // Clipboard blocked; no-op.
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={onCopy} className="justify-start gap-2">
      {copied
        ? <Check aria-hidden className="size-4 text-emerald-500" />
        : <Link2 aria-hidden className="size-4" />}
      <span>{copied ? 'Link copied' : 'Copy share link'}</span>
    </Button>
  )
}

function MarkDeliveredAction({ signature }: { signature: string }) {
  // Dismissal writes to localStorage and dispatches a custom event;
  // BridgeHistory's `useDismissedBridges` re-renders and the row's
  // badge flips to Delivered. No need to navigate or refresh here —
  // the parent page also reads from the same source.
  const [done, setDone] = useState(false)
  const onClick = () => {
    dismissBridge(signature)
    setDone(true)
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      disabled={done}
      className="justify-start gap-2"
      title="Funds already in your wallet? Mark this row delivered. Per-device only; does not affect on-chain state."
    >
      <Check aria-hidden className="size-4" />
      <span>{done ? 'Marked delivered' : 'Mark as delivered'}</span>
    </Button>
  )
}

function HelpAction({ signature }: { signature: string }) {
  // Prefill a GitHub issue with the tx signature so the user doesn't
  // have to copy-paste. The issue body is intentionally a checklist
  // template so the maintainer triage is fast.
  const issueUrl = new URL('https://github.com/pointgroup-labs/fogo-onre/issues/new')
  issueUrl.searchParams.set('title', `Bridge stalled: ${signature.slice(0, 8)}…`)
  issueUrl.searchParams.set(
    'body',
    [
      `**Source signature:** \`${signature}\``,
      '',
      '**What I expected:** funds delivered to my FOGO wallet within a few minutes.',
      '',
      '**What happened:** (please describe)',
      '',
      `**Wormholescan link:** https://wormholescan.io/#/tx/${signature}`,
    ].join('\n'),
  )
  return (
    <Button asChild variant="ghost" size="sm" className="justify-start gap-2">
      <a href={issueUrl.toString()} target="_blank" rel="noopener noreferrer">
        <LifeBuoy aria-hidden className="size-4" />
        <span>Report a problem</span>
      </a>
    </Button>
  )
}
