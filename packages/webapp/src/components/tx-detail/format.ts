/**
 * Display formatters shared by the detail view. Kept separate from
 * component files so they can be unit-tested without React-DOM and
 * so the timeline / hero share one canonical implementation (no risk
 * of "shows 3.21 here, 3.2 there" divergence).
 */

export function formatAmount(raw: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = raw / divisor
  const fraction = raw % divisor
  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 4)
  const trimmed = fractionStr.replace(/0+$/, '')
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole.toString()
}

/**
 * Compact relative-time label. Same shape as `BridgeHistory`'s helper
 * but lives here so the detail view doesn't reach across module
 * boundaries. Caller threads `nowMs` so renders stay pure.
 */
export function formatRelativeTime(thenMs: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - thenMs)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) {
    return 'just now'
  }
  const min = Math.floor(sec / 60)
  if (min < 60) {
    return `${min} min ago`
  }
  const hr = Math.floor(min / 60)
  if (hr < 24) {
    return `${hr} h ago`
  }
  const day = Math.floor(hr / 24)
  if (day < 7) {
    return `${day} d ago`
  }
  return new Date(thenMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatAbsoluteTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
