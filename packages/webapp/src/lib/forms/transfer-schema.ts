import { z } from 'zod'

export interface TransferSchemaContext {
  /** Maximum balance as a base-unit decimal string. */
  maxAmountStr: string
  /** Number of token decimals. */
  decimals: number
}

export function makeTransferSchema({ maxAmountStr, decimals }: TransferSchemaContext) {
  return z.object({
    amount: z
      .string()
      .min(1, 'Required')
      .refine(v => /^\d+(?:\.\d+)?$/.test(v), 'Invalid number')
      .refine((v) => {
        const dotIdx = v.indexOf('.')
        return dotIdx === -1 || v.length - dotIdx - 1 <= decimals
      }, `Max ${decimals} decimals`)
      .refine(v => Number(v) > 0, 'Must be > 0')
      .refine((v) => {
        // String-compare base-unit equivalents to avoid float coercion.
        // Uses BigInt parsing on `<digits-without-dot>` padded by `decimals`.
        const norm = (s: string) => {
          const [w, f = ''] = s.split('.')
          return BigInt(w + f.padEnd(decimals, '0').slice(0, decimals))
        }
        return norm(v) <= norm(maxAmountStr)
      }, 'Exceeds balance'),
  })
}

export type TransferFormValues = z.infer<ReturnType<typeof makeTransferSchema>>
