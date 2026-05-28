import type { OperationStatus } from './types'
import { z } from 'zod'
import { FOGO_ONYC_DECIMALS, FOGO_ONYC_MINT, USDC_DECIMALS, USDC_S_MINT } from '@/constants'

/**
 * Wormholescan-driven history source. Replaces FOGO `getSignaturesForAddress`
 * paging — the public `mainnet.fogo.io` RPC retains only ~5 days of
 * signatures, so anything older silently disappeared from the burn-page
 * scan. Wormholescan indexes every NTT VAA permanently, so a single
 * `/operations?address=<user>` call returns the full cross-chain
 * history of that wallet regardless of FOGO RPC retention.
 */

export const FOGO_CHAIN_ID = 51
const WORMHOLESCAN_BASE = 'https://api.wormholescan.io/api/v1'
const REQUEST_TIMEOUT_MS = 8000
/**
 * How far back to scan for a delivery leg matching an outbound burn.
 * Normal deliveries land in seconds, but manual relayer recoveries and
 * guardian-signing stalls can push the USDC return leg past a day. The
 * window is wide because mutual-nearest pairing (see
 * `classifyOpsIntoActions`) rejects mismatches — a distant delivery only
 * pairs when it is also the burn's nearest counterpart, so a wide window
 * can't silently cross-pair two unrelated flows.
 */
export const PAIRING_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000
/** Tolerated burn↔delivery clock skew on the "delivery before burn" side. */
export const PAIRING_SKEW_MS = 5_000

const OperationSchema = z.object({
  id: z.string(),
  sourceChain: z.object({
    chainId: z.number(),
    timestamp: z.string(),
    from: z.string().optional(),
    transaction: z.object({ txHash: z.string() }),
  }),
  targetChain: z
    .object({
      chainId: z.number().optional(),
      timestamp: z.string().optional(),
      status: z.string().optional(),
      to: z.string().optional(),
      transaction: z.object({ txHash: z.string() }).optional(),
    })
    .optional(),
  content: z
    .object({
      payload: z
        .object({
          nttMessage: z
            .object({
              trimmedAmount: z
                .object({
                  amount: z.string(),
                  decimals: z.number(),
                })
                .optional(),
            })
            .optional(),
        })
        .optional(),
      standarizedProperties: z
        .object({
          fromAddress: z.string().optional(),
          toAddress: z.string().optional(),
          tokenAddress: z.string().optional(),
          tokenChain: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
  data: z
    .object({
      symbol: z.string().optional(),
      tokenAmount: z.string().optional(),
    })
    .optional(),
})
type WormholescanOp = z.infer<typeof OperationSchema>
export type { WormholescanOp }

const ResponseSchema = z.object({
  operations: z.array(OperationSchema).optional(),
})

const PAGE_SIZE = 50

export interface WormholescanPage {
  ops: WormholescanOp[]
  hasMore: boolean
}

/**
 * Fetch one page of Wormholescan operations involving the given address.
 * The `address` filter matches any of: source `from`, target `to`,
 * standardized payload `fromAddress`/`toAddress`. That's broader than
 * "user-originated" — both halves of a deposit/withdraw round-trip
 * appear, which is what the grouping pass below needs.
 *
 * NOTE: Wormholescan paging is **0-indexed**. Page 0 is the most
 * recent results; page 1 starts the next 50. Passing page 1 first
 * silently skips every result newer than the 51st row — historically
 * the source of an "empty history" bug that was hard to spot because
 * the response is a well-formed `{operations: []}` rather than an error.
 */
export async function fetchAddressOpsPage(
  address: string,
  page: number,
): Promise<WormholescanPage> {
  const url = `${WORMHOLESCAN_BASE}/operations?address=${encodeURIComponent(address)}&pageSize=${PAGE_SIZE}&page=${page}`
  const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) {
    throw new Error(`Wormholescan ${res.status}`)
  }
  const json: unknown = await res.json()
  const parsed = ResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error('Wormholescan response failed schema')
  }
  const ops = parsed.data.operations ?? []
  return { ops, hasMore: ops.length === PAGE_SIZE }
}

/**
 * Token decimals lookup, keyed on the Wormholescan-reported `symbol`.
 * Wormholescan emits uppercase "USDC" for the USDC.s leg and lowercase
 * "onyc" for the ONyc leg — both spellings are normalized via case-
 * insensitive lookup. Unknown symbols yield `null` so the row is
 * dropped rather than rendering a bogus amount.
 */
function decimalsForSymbol(symbol: string | undefined): number | null {
  if (symbol === undefined) {
    return null
  }
  const s = symbol.toLowerCase()
  if (s === 'usdc') {
    return USDC_DECIMALS
  }
  if (s === 'onyc') {
    return FOGO_ONYC_DECIMALS
  }
  return null
}

/**
 * Parse a Wormholescan `tokenAmount` (decimal string like "1.090588")
 * into raw units. Returns null on garbage input or unknown decimals so
 * the row is silently dropped — better than rendering NaN.
 */
function parseTokenAmount(amountStr: string | undefined, decimals: number): bigint | null {
  if (amountStr === undefined || !/^\d+(?:\.\d+)?$/.test(amountStr)) {
    return null
  }
  const [whole, fraction = ''] = amountStr.split('.')
  if (fraction.length > decimals) {
    // Unexpected over-precision — drop rather than truncate silently.
    return null
  }
  const padded = fraction.padEnd(decimals, '0')
  try {
    return BigInt(`${whole}${padded}`)
  } catch {
    return null
  }
}

/**
 * Rescale a raw amount from one decimal scale to another. NTT wire
 * format uses a "trimmed" amount with `decimals = min(8, on-chain
 * decimals)`; the row displays at the on-chain decimal precision
 * (USDC=6, FOGO ONyc=9). For ONyc this means scaling up by 10× to
 * land at the right raw amount; for USDC it's a no-op. Scaling down
 * (target < source) would lose precision — we refuse it and return
 * null so the row drops instead of silently truncating.
 */
function rescale(raw: bigint, fromDecimals: number, toDecimals: number): bigint | null {
  if (toDecimals === fromDecimals) {
    return raw
  }
  if (toDecimals > fromDecimals) {
    return raw * 10n ** BigInt(toDecimals - fromDecimals)
  }
  return null
}

/**
 * Extract a raw amount from one op, rescaled to `displayDecimals`.
 * Two sources, in order:
 *   1. `data.tokenAmount` + `data.symbol` → decimals: present for
 *      Solana-side ops (deposits' source burn, withdraws' delivery).
 *   2. `content.payload.nttMessage.trimmedAmount` → always present
 *      on NTT VAAs; the fallback for FOGO-originated ops where
 *      Wormholescan's enrichment leaves `data` undefined (the entire
 *      reason the previous "borrow delivery amount" fallback was
 *      broken — it crossed token boundaries).
 */
export function extractAmount(op: WormholescanOp, displayDecimals: number): bigint | null {
  const dataDecimals = decimalsForSymbol(op.data?.symbol)
  if (dataDecimals !== null && op.data?.tokenAmount !== undefined) {
    const raw = parseTokenAmount(op.data.tokenAmount, dataDecimals)
    if (raw !== null) {
      return rescale(raw, dataDecimals, displayDecimals)
    }
  }
  const trimmed = op.content?.payload?.nttMessage?.trimmedAmount
  if (trimmed !== undefined) {
    let rawBig: bigint
    try {
      rawBig = BigInt(trimmed.amount)
    } catch {
      return null
    }
    return rescale(rawBig, trimmed.decimals, displayDecimals)
  }
  return null
}

export function timestampToSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}

export function mapTargetStatus(targetStatus: string | undefined): OperationStatus['kind'] {
  if (targetStatus === 'completed') {
    return 'delivered'
  }
  if (targetStatus === 'pending' || targetStatus === undefined) {
    return 'pending'
  }
  return 'unknown'
}

export interface Classified {
  op: WormholescanOp
  /** Direction relative to the user on FOGO. */
  dir: 'outbound' | 'inbound'
  /** Token leg, derived from `data.symbol`. */
  token: 'usdc' | 'onyc'
}

/**
 * Classify each op by direction (user as FOGO sender vs FOGO recipient)
 * and which token leg it represents. Ops that don't fit either pattern
 * (foreign relayer-to-relayer hops, or symbols we don't recognize) are
 * dropped — they're not user-visible history.
 *
 * Inbound detection does NOT match `std.toAddress` against the user:
 * that field is `None` on every inbound NTT VAA (Wormholescan decodes
 * the recipient into `nttMessage.to`, not the standardized props), so
 * gating on it dropped 100% of deliveries — the "inbound=0" bug where
 * redeems never paired and orphan-deposit rows never formed. The
 * `?address=` query already scopes results to this user, so an op
 * delivered to FOGO that the user didn't originate IS their inbound leg.
 */
export function classifyOps(ops: WormholescanOp[], userB58: string): Classified[] {
  const out: Classified[] = []
  for (const op of ops) {
    const std = op.content?.standarizedProperties
    const symbol = op.data?.symbol?.toLowerCase()

    // Symbol is reported on most ops; for outbound ONyc burns from
    // FOGO, Wormholescan currently leaves `data` undefined. Fall back
    // to inferring the token from `standardizedProperties.tokenAddress`.
    let token: 'usdc' | 'onyc' | null = null
    if (symbol === 'usdc') {
      token = 'usdc'
    } else if (symbol === 'onyc') {
      token = 'onyc'
    } else if (std?.tokenAddress === FOGO_ONYC_MINT.toBase58()) {
      token = 'onyc'
    } else if (std?.tokenAddress === USDC_S_MINT.toBase58()) {
      token = 'usdc'
    }
    if (token === null) {
      continue
    }

    const isOutbound
      = op.sourceChain.chainId === FOGO_CHAIN_ID
        && (op.sourceChain.from === userB58 || std?.fromAddress === userB58)
    // FOGO-target + not the user's own outbound = their delivery.
    const isInbound
      = !isOutbound && op.targetChain?.chainId === FOGO_CHAIN_ID

    if (isOutbound) {
      out.push({ op, dir: 'outbound', token })
    } else if (isInbound) {
      out.push({ op, dir: 'inbound', token })
    }
  }
  return out
}

/**
 * Treated as the natural unit of progress for `BridgeHistory`'s "Load
 * older" affordance. Each Wormholescan page is mapped + grouped
 * independently, then concatenated — grouping across page boundaries
 * could mis-pair a withdraw burn on page N with a delivery on page
 * N+1, but in practice both legs of a round-trip share a Wormholescan
 * timestamp window of seconds and are returned in the same page.
 */
export const WORMHOLESCAN_PAGE_SIZE = PAGE_SIZE
