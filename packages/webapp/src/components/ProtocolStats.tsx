'use client'

import { Suspense } from 'react'
import Statistic from '@/components/Statistic'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS } from '@/constants'
import { useFogoOnycSupply } from '@/hooks/useFogoOnycSupply'
import { useProtocolState } from '@/hooks/useProtocolState'

/**
 * Top-of-page stats strip. Three at-a-glance metrics that tell a user
 * "is this worth my attention?" before they scroll to the form:
 *
 *   - APY  — yield rate, derived from the OnRe price snapshot's `aprBps`
 *   - NAV  — current ONyc price in USDC, derived from the live ONyc
 *            price feed scaled to its `priceScale`
 *   - TVL  — total value locked. Vault-less model: TVL = FOGO ONyc mint
 *            supply × NAV. Every ONyc on FOGO was minted by the relayer
 *            against a user deposit, so the mint supply IS the protocol's
 *            on-chain locked principal. Once the FOGO vault program ships
 *            this becomes `usdc_reserve + onyc_balance × nav` — the
 *            current formula is the limiting case where `usdc_reserve = 0`.
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
  const onycSupply = useFogoOnycSupply()
  const apy = formatApy(protocol.price.aprBps)
  const nav = formatNav(protocol.onycPrice, protocol.price.priceScale)
  const tvl = formatTvl(onycSupply, protocol.onycPrice, protocol.price.priceScale)
  const preview = protocol.priceIsPreview && nav !== '—'
  // TVL inherits NAV's preview state: if the price feed hasn't loaded,
  // the supply * nav product is built from placeholder NAV and shouldn't
  // be presented as authoritative.
  const tvlPreview = preview && tvl !== '—'

  return (
    <div className="grid grid-cols-3 gap-3">
      <Card><CardContent className="p-4"><Statistic label="APY" value={apy} /></CardContent></Card>
      <Card><CardContent className="p-4"><Statistic label="NAV" value={nav} preview={preview} /></CardContent></Card>
      <Card><CardContent className="p-4"><Statistic label="TVL" value={tvl} preview={tvlPreview} /></CardContent></Card>
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

/**
 * TVL = supply_onyc_base × onycPrice / priceScale, expressed as dollars.
 *
 * Bigint derivation (no floats):
 *   supplyRaw is in ONyc base units (×10^FOGO_ONYC_DECIMALS).
 *   `onycPrice / priceScale` is USDC base per ONyc base.
 *   So `supplyRaw * onycPrice / priceScale` = TVL in USDC base units
 *     (×10^USDC_DECIMALS).
 *   Divide by 10^USDC_DECIMALS to get dollars.
 *
 * To preserve two decimal places of precision through the bigint divide
 * without losing them to integer truncation, we multiply by 100 before
 * the final divide. That gives us cents; then a single divide-and-
 * remainder yields dollars + 2-digit fraction.
 *
 * Magnitude formatting: TVL ranges across orders of magnitude during a
 * protocol's life (thousands while bootstrapping, millions at maturity).
 * `$1,234,567.89` is hard to scan; `$1.23M` reads instantly. K/M/B
 * thresholds are the DeFi standard (DeFiLlama, Pendle, etc.) so users
 * compare on equal footing.
 */
function formatTvl(
  supplyRaw: bigint | null,
  onycPrice: bigint | null,
  priceScale: bigint | null,
): string {
  if (
    supplyRaw === null
    || onycPrice === null
    || priceScale === null
    || priceScale === 0n
    || supplyRaw === 0n
  ) {
    return '—'
  }
  // Cents = supplyRaw * onycPrice * 100 / (priceScale * 10^USDC_DECIMALS).
  const usdcUnit = 10n ** BigInt(USDC_DECIMALS)
  const cents = (supplyRaw * onycPrice * 100n) / (priceScale * usdcUnit)
  if (cents === 0n) {
    // Sub-cent TVL — display as "<$0.01" rather than "$0.00", which
    // would read as "nothing locked" when in fact there's dust.
    return '<$0.01'
  }
  return formatDollarsFromCents(cents)
}

/**
 * Format a non-zero bigint cents value as a compact dollar string with
 * K/M/B suffix when warranted. Returns:
 *   - < $1K     → "$1,234.56"
 *   - < $1M     → "$12.3K"
 *   - < $1B     → "$1.23M"
 *   - ≥ $1B     → "$1.23B"
 *
 * Threshold picks: switch to the suffix once the integer part needs
 * more than 4 digits, the point at which scan-readability drops off.
 */
function formatDollarsFromCents(cents: bigint): string {
  const dollars = cents / 100n
  if (dollars < 1_000n) {
    const whole = dollars
    const frac = (cents % 100n).toString().padStart(2, '0')
    return `$${formatThousands(whole)}.${frac}`
  }
  if (dollars < 1_000_000n) {
    // $X.YK — 1 fractional digit. Compute by dividing cents by 10_000
    // (= $100), giving an integer count of "tenths of K".
    const tenthsOfK = cents / 10_000n
    return `$${(tenthsOfK / 10n).toString()}.${(tenthsOfK % 10n).toString()}K`
  }
  if (dollars < 1_000_000_000n) {
    // $X.YYM — 2 fractional digits. cents / 10_000 = hundredths of $100,
    // i.e. hundredths-of-K; cents / 1_000_000 = hundredths-of-M.
    const hundredthsOfM = cents / 1_000_000n
    return `$${formatTwoFrac(hundredthsOfM)}M`
  }
  const hundredthsOfB = cents / 1_000_000_000n
  return `$${formatTwoFrac(hundredthsOfB)}B`
}

function formatTwoFrac(hundredths: bigint): string {
  const whole = hundredths / 100n
  const frac = (hundredths % 100n).toString().padStart(2, '0')
  return `${formatThousands(whole)}.${frac}`
}

function formatThousands(n: bigint): string {
  // Locale-free grouping — Number.toLocaleString would lose precision
  // for n > 2^53, and we render server-side so locale availability is
  // also a concern. Manual grouping keeps the output deterministic.
  const s = n.toString()
  if (s.length <= 3) {
    return s
  }
  const out: string[] = []
  for (let i = s.length; i > 0; i -= 3) {
    out.unshift(s.slice(Math.max(0, i - 3), i))
  }
  return out.join(',')
}
