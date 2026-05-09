'use client'

import type { TimelineRow } from '@/lib/bridgeHistory/types'
import { isEstablished, useSession } from '@fogo/sessions-sdk-react'
import { useIsRestoring } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS } from '@/constants'
import { useBridgeHistory } from '@/hooks/useBridgeHistory'
import { fogoTxUrl } from '@/utils/explorers'

export default function BridgeHistory() {
  // Same hydration pattern as PendingTxList: defer the restoring branch
  // to a post-mount render so the first client paint matches the SSR
  // empty render.
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  const restoring = useIsRestoring()

  const session = useSession()
  const owner = isEstablished(session) ? session.walletPublicKey : null
  const { rows, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useBridgeHistory(owner)

  if (owner === null) {
    return null
  }

  if (mounted && restoring) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    )
  }

  if (isError && rows.length === 0) {
    return (
      <Alert>
        <AlertTitle>Bridge history unavailable</AlertTitle>
        <AlertDescription>Couldn&apos;t load history. Try again in a moment.</AlertDescription>
      </Alert>
    )
  }

  if (rows.length === 0) {
    return (
      <Alert>
        <AlertTitle>No bridges yet</AlertTitle>
        <AlertDescription>Your bridge history will appear here.</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <ul aria-label="Bridge history" className="flex flex-col gap-2">
        {rows.map(r => <li key={r.signature}><BridgeRow row={r} /></li>)}
      </ul>
      {hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="self-center text-xs text-muted-foreground"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}

function BridgeRow({ row }: { row: TimelineRow }) {
  const decimals = row.kind === 'deposit' ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const ticker = row.kind === 'deposit' ? 'USDC.s' : 'ONyc'
  const directionIcon = row.kind === 'deposit' ? '↗' : '↘'
  const label = row.kind === 'deposit' ? 'Deposit' : 'Withdraw'
  const amount = formatAmount(row.amountRaw, decimals)
  const time = new Date(row.blockTime * 1000).toLocaleString()
  // Deposit-only annotation: `amountIsGross` means we have no journal
  // entry for this signature, so `amountRaw` is the on-chain burn
  // delta (principal + bridge fee). Withdraws don't deduct via
  // `FeeConfig.bridge_transfer_fee`, so their burn delta IS the
  // principal — no annotation needed.
  const showFeeAnnotation = row.kind === 'deposit' && row.amountIsGross

  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-3">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">
            <span aria-hidden className="mr-1 text-muted-foreground">{directionIcon}</span>
            {label}
            {' · '}
            {amount}
            {' '}
            {ticker}
            {showFeeAnnotation && (
              <>
                {' '}
                <span className="text-xs font-normal text-muted-foreground">(incl. fee)</span>
              </>
            )}
          </span>
          <StatusBadge row={row} />
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{time}</span>
          <span className="flex items-center gap-2">
            <a href={fogoTxUrl(row.signature)} target="_blank" rel="noreferrer noopener" className="hover:underline">
              source ↗
            </a>
            {row.destinationSignature !== null && (
              <a href={fogoTxUrl(row.destinationSignature)} target="_blank" rel="noreferrer noopener" className="hover:underline">
                dest ↗
              </a>
            )}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge({ row }: { row: TimelineRow }) {
  // Precedence: phase > status. `unknown` renders no badge (graceful degrade).
  if (row.phase !== null) {
    return <Badge variant="secondary" aria-label={`status: ${row.phase}`}>{row.phase}</Badge>
  }
  if (row.status === 'delivered') {
    return <Badge variant="default" aria-label="status: delivered">Delivered</Badge>
  }
  if (row.status === 'pending') {
    return <Badge variant="secondary" aria-label="status: bridging">Bridging…</Badge>
  }
  return null
}

function formatAmount(raw: bigint, decimals: number): string {
  // Display two decimal places of precision, dropping trailing zeros.
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const fraction = raw % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 2)
  // Strip trailing zeros from the 2-char fraction
  const trimmed = fractionStr.replace(/0+$/, '')
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole.toString()
}
