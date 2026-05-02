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

export function parseAmount(input: string, decimals: number): bigint | null {
  if (!input || !/^\d*\.?\d*$/.test(input)) {
    return null
  }
  const [whole, fraction = ''] = input.split('.')
  if (fraction.length > decimals) {
    return null
  }
  const padded = fraction.padEnd(decimals, '0')
  const combined = `${whole || '0'}${padded}`
  try {
    return BigInt(combined)
  }
  catch {
    return null
  }
}

export function formatAmount(value: bigint, decimals: number): string {
  const s = value.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const fraction = s.slice(s.length - decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}
