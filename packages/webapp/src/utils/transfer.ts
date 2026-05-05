export type TxStatus
  = | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'success', signature: string }
    | { kind: 'error', message: string }

export const idle: TxStatus = { kind: 'idle' }
export const pending: TxStatus = { kind: 'pending' }

export function success(signature: string): TxStatus {
  return { kind: 'success', signature }
}

export function error(message: string): TxStatus {
  return { kind: 'error', message }
}

export interface ParseResult {
  /** Parsed base-units value, or `null` if the input failed to parse. */
  value: bigint | null
  /** Human-readable reason for parse failure (or `null` when value is set). */
  error: string | null
}

/**
 * Parse a decimal-string amount into base units. Distinguishes between
 * "empty input" (no error) and "malformed / too many decimals" (with a
 * reason) so callers can render targeted helper text instead of a silent
 * "—".
 *
 * Behaviour:
 *   ""        → { value: null, error: null }   // user hasn't typed
 *   "abc"     → { value: null, error: 'Numbers only.' }
 *   "1.234"   → { value: 1234000n, error: null }     (decimals=6)
 *   "1.1234567" → { value: null, error: 'USDC.s only supports 6 decimals.' }
 */
export function parseAmount(input: string, decimals: number, symbol?: string): ParseResult {
  if (input === '') {
    return { value: null, error: null }
  }
  if (!/^\d*(?:\.\d*)?$/.test(input)) {
    return { value: null, error: 'Numbers only.' }
  }
  const [whole, fraction = ''] = input.split('.')
  if (fraction.length > decimals) {
    const symbolLabel = symbol ? `${symbol} ` : ''
    return {
      value: null,
      error: `${symbolLabel}only supports ${decimals} decimals.`,
    }
  }
  const padded = fraction.padEnd(decimals, '0')
  const combined = `${whole || '0'}${padded}`
  try {
    return { value: BigInt(combined), error: null }
  } catch {
    return { value: null, error: 'Could not parse number.' }
  }
}

export function formatAmount(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const fraction = s.slice(s.length - decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
