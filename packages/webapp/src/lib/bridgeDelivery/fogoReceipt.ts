import type { Connection, ParsedTransactionWithMeta } from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import {
  FOGO_ONYC_MINT,
  FOGO_ONYC_NTT_MANAGER_ID,
  FOGO_USDC_S_NTT_MANAGER_ID,
  USDC_S_MINT,
} from '@/constants'

/**
 * Deterministic FOGO-side delivery detection. Symmetric counterpart to
 * `bridgeHistory/rpc.ts:fetchBurnPage` — that file picks *negative*
 * deltas (user-initiated burns); this one picks the first *positive*
 * delta newer than the source burn (relayer-initiated mint).
 *
 * **Why this exists:** `useFlowStatus` watches balance-vs-baseline,
 * which requires a baseline snapshot taken before the user signed — so
 * it only works on the originating device/session (journal-backed).
 * On a cold-share link (different device, different tab, page reload
 * after journal eviction), the baseline is gone and the watcher can't
 * tell whether the current balance already includes prior bridges.
 *
 * Enumeration sidesteps that problem entirely. We don't need a
 * baseline — we ask "is there an inbound transfer to your dest ATA
 * touching an NTT-manager program, with positive delta, signed *after*
 * the source burn's blockTime?" If yes, that tx IS the return-leg mint.
 *
 * **False-positive impossibility:** the allowlist gate (`accountKeys`
 * must include an NTT manager program) means only the relayer's
 * `release_inbound_mint` (deposit) or NTT-bridge-out (withdraw) can
 * satisfy the predicate. A direct user→user transfer of ONyc/USDC.s
 * would not touch an NTT manager and would be filtered out. The
 * `blockTime > sourceBlockTime` clamp prevents matching the user's own
 * historical inbound transfers from prior bridges.
 *
 * **Race with prior bridges:** when a user runs back-to-back bridges
 * before the first one's return leg lands, the *first* positive-delta
 * tx newer than `sourceBlockTime` is by construction the first to
 * arrive after the user's burn. Subsequent bridges (whose burns happen
 * later) get their own `sourceBlockTime` cutoff and find their own
 * return-leg mints. Each bridge's return-leg has a one-to-one
 * relationship to its corresponding burn; ordering on the destination
 * ATA preserves that mapping.
 */

const PROGRAM_ALLOWLIST: ReadonlySet<string> = new Set([
  FOGO_USDC_S_NTT_MANAGER_ID.toBase58(),
  FOGO_ONYC_NTT_MANAGER_ID.toBase58(),
])

/**
 * Bound on how far back we scan the destination ATA's history. A
 * deposit's round-trip is minutes; a withdraw can take up to ~24h
 * (OnRe redemption fulfilment). 100 sigs at FOGO's tx rate covers
 * even an active user's worth of receives across the longest expected
 * window — well past the 24h withdraw upper bound for any plausible
 * deposit frequency. If a flow legitimately takes longer than this
 * many receives can cover, the user can hit dismiss; we'd rather miss
 * a delivery quietly than chew an unbounded RPC budget.
 */
const SCAN_PAGE_SIZE = 100

export type FogoDeliveryReceipt
  = | { kind: 'delivered', signature: string, slot: number, blockTime: number }
    | { kind: 'pending' }
    | { kind: 'unknown' }

export interface FogoDeliveryQuery {
  owner: PublicKey
  /** 'deposit' → dest mint is FOGO ONyc; 'withdraw' → dest mint is USDC.s. */
  kind: 'deposit' | 'withdraw'
  /** Block time (unix seconds) of the user's source burn. Anything older is ignored. */
  sourceBlockTime: number
}

/**
 * Resolve the destination ATA for a flow kind. Deposit ends in ONyc
 * on the user's FOGO wallet; withdraw ends in USDC.s. Mirrors the
 * same map in `useFlowStatus`.
 */
export function destinationAtaForKind(owner: PublicKey, kind: 'deposit' | 'withdraw'): {
  ata: PublicKey
  mint: PublicKey
} {
  const mint = kind === 'deposit' ? FOGO_ONYC_MINT : USDC_S_MINT
  return { ata: getAssociatedTokenAddressSync(mint, owner), mint }
}

/**
 * Page through the destination ATA's recent signatures looking for
 * the first NTT-mediated positive-delta receive newer than the
 * source burn's blockTime. Returns `delivered` with the receipt tx
 * the moment one is found, `pending` if none has appeared yet, or
 * `unknown` on RPC failure (so the caller can render a graceful badge
 * rather than a misleading "pending forever").
 */
export async function fetchFogoDeliveryReceipt(
  connection: Connection,
  query: FogoDeliveryQuery,
): Promise<FogoDeliveryReceipt> {
  const { ata, mint } = destinationAtaForKind(query.owner, query.kind)

  let sigs
  try {
    sigs = await connection.getSignaturesForAddress(
      ata,
      { limit: SCAN_PAGE_SIZE },
      'finalized',
    )
  } catch {
    return { kind: 'unknown' }
  }

  if (sigs.length === 0) {
    return { kind: 'pending' }
  }

  // Filter to sigs newer than the source burn. RPC returns newest first,
  // so we keep the natural order — the *first* match we find by scanning
  // back-to-front is the *oldest* qualifying tx, which is the correct
  // one (the first return-leg mint after the burn).
  const candidates = sigs.filter((s) => {
    if (s.err !== null) {
      return false
    }
    if (s.blockTime === null || s.blockTime === undefined) {
      return false
    }
    return s.blockTime > query.sourceBlockTime
  })
  if (candidates.length === 0) {
    return { kind: 'pending' }
  }

  // Iterate oldest-to-newest among candidates so the first qualifying
  // hit is the chronologically-first return-leg mint after the burn.
  const ordered = [...candidates].reverse()

  // Parse only as many txs as needed — bail at first delivered hit.
  // This keeps the common-case RPC cost to one parsed tx, not 100.
  for (const sigInfo of ordered) {
    let tx: ParsedTransactionWithMeta | null
    try {
      tx = await connection.getParsedTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'finalized',
      })
    } catch {
      // One parse failure shouldn't abort the whole scan — continue.
      continue
    }
    if (isReturnLegReceipt(tx, ata, mint)) {
      return {
        kind: 'delivered',
        signature: sigInfo.signature,
        slot: sigInfo.slot,
        blockTime: sigInfo.blockTime ?? 0,
      }
    }
  }

  return { kind: 'pending' }
}

/**
 * Pure: given a parsed tx and the destination ATA, decide whether this
 * tx is an NTT-mediated positive-delta receive into that ATA.
 *
 * Three gates, all required:
 *   1. tx succeeded (no `meta.err`)
 *   2. accountKeys contains an NTT manager program (otherwise it's a
 *      manual transfer or unrelated tx — not from the bridge)
 *   3. signed delta on the dest ATA is strictly positive
 *
 * The mint check is structural: pre/post token balances must reference
 * the expected mint. This guards against an edge case where the same
 * owner has both ATAs and an unrelated mint event somehow matched
 * accountIndex by coincidence (defensive; not observed in practice).
 */
function isReturnLegReceipt(
  tx: ParsedTransactionWithMeta | null,
  destAta: PublicKey,
  expectedMint: PublicKey,
): boolean {
  if (tx === null || tx.meta === null || tx.meta.err !== null) {
    return false
  }
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58())
  if (!keys.some(k => PROGRAM_ALLOWLIST.has(k))) {
    return false
  }

  const ataB58 = destAta.toBase58()
  const mintB58 = expectedMint.toBase58()
  const pre = tx.meta.preTokenBalances?.find(
    b => keys[b.accountIndex] === ataB58 && b.mint === mintB58,
  )
  const post = tx.meta.postTokenBalances?.find(
    b => keys[b.accountIndex] === ataB58 && b.mint === mintB58,
  )
  if (pre === undefined && post === undefined) {
    return false
  }

  const preAmt = BigInt(pre?.uiTokenAmount.amount ?? '0')
  const postAmt = BigInt(post?.uiTokenAmount.amount ?? '0')
  return postAmt > preAmt
}
