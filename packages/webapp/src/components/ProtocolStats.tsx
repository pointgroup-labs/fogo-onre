'use client'

import { Suspense } from 'react'
import Statistic from '@/components/Statistic'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS } from '@/constants'
import { useProtocolState } from '@/hooks/useProtocolState'

/**
 * Top-of-page stats strip. Three at-a-glance metrics that tell a user
 * "is this worth my attention?" before they scroll to the form:
 *
 *   - APY  — yield rate, derived from the OnRe price snapshot's `aprBps`
 *   - AUM  — total value locked across the vault (not yet on-chain;
 *            placeholder until the FOGO vault program ships)
 *   - NAV  — current ONyc price in USDC, derived from the live ONyc
 *            price feed scaled to its `priceScale`
 *
 * Values that aren't computable yet render as a muted "—". We intentionally
 * don't fall back to mocked numbers — a fake "$166.83M" badge would erode
 * trust the moment a user cross-checked it on-chain.
 */
export default function ProtocolStats() {
  return (
    <Suspense fallback={<ProtocolStatsSkeleton />}>
      <ProtocolStatsInner />
    </Suspense>
  )
}

function ProtocolStatsInner() {
  const protocol = useProtocolState()
  const apy = formatApy(protocol.price.aprBps)
  const nav = formatNav(protocol.onycPrice, protocol.price.priceScale)
  const preview = protocol.priceIsPreview && nav !== '—'

  return (
    <div className="grid grid-cols-3 gap-3">
      <Card><CardContent className="p-4"><Statistic label="APY" value={apy} /></CardContent></Card>
      <Card><CardContent className="p-4"><Statistic label="AUM" value="—" /></CardContent></Card>
      <Card><CardContent className="p-4"><Statistic label="NAV" value={nav} preview={preview} /></CardContent></Card>
    </div>
  )
}

function ProtocolStatsSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-3">
      {[0, 1, 2].map(i => (
        <Card key={i}><CardContent className="p-4"><Skeleton className="h-12" /></CardContent></Card>
      ))}
    </div>
  )
}

function formatApy(aprBps: number | null): string {
  if (aprBps === null || aprBps <= 0) {
    return '—'
  }
  return `${(aprBps / 100).toFixed(2)}%`
}

function formatNav(onycPrice: bigint | null, priceScale: bigint | null): string {
  if (onycPrice === null || priceScale === null || priceScale === 0n) {
    return '—'
  }
  // `onycPrice / priceScale` is "USDC base per ONyc base". To convert to
  // USDC-per-ONyc (the human price) we multiply by 10^(ONyc decimals -
  // USDC decimals), which lifts the small base ratio (~1e-3 for ONyc≈$1)
  // up into a familiar dollar magnitude. With FOGO_ONYC=9, USDC=6, the
  // multiplier is 10^3 = 1000, so a 1.07 USDC/ONyc price decodes from
  // basePrice=1_069_802_350 / 1e12 = 0.00107, ×1000 = 1.07.
  const decimalAdjust = 10n ** BigInt(FOGO_ONYC_DECIMALS - USDC_DECIMALS)
  // 4 fractional digits — ONyc trades close to par, so two decimals
  // would erase all signal.
  const fractionDigits = 4
  const factor = 10n ** BigInt(fractionDigits)
  const scaled = (onycPrice * decimalAdjust * factor) / priceScale
  const whole = scaled / factor
  const frac = scaled % factor
  const fracStr = frac.toString().padStart(fractionDigits, '0')
  return `$${whole.toString()}.${fracStr}`
}
