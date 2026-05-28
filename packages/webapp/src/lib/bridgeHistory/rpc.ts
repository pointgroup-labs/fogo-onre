import type { Connection, ParsedTransactionWithMeta } from '@solana/web3.js'
import type { BurnRow } from './types'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import {
  FOGO_ONYC_MINT,
  FOGO_ONYC_NTT_MANAGER_ID,
  FOGO_USDC_S_NTT_MANAGER_ID,
  USDC_S_MINT,
} from '@/constants'

/**
 * Programs that, if present in `accountKeys`, mark a tx as a bridge
 * operation we want to surface. Manual ATA-to-ATA transfers, swaps,
 * airdrops, etc. fail this check and are dropped.
 */
const PROGRAM_ALLOWLIST: ReadonlySet<string> = new Set([
  FOGO_USDC_S_NTT_MANAGER_ID.toBase58(),
  FOGO_ONYC_NTT_MANAGER_ID.toBase58(),
])

const RPC_PAGE_SIZE = 50

export interface AtaBinding {
  ata: PublicKey
  mint: PublicKey
}

export function getCanonicalAtas(owner: PublicKey): AtaBinding[] {
  return [
    { ata: getAssociatedTokenAddressSync(USDC_S_MINT, owner), mint: USDC_S_MINT },
    { ata: getAssociatedTokenAddressSync(FOGO_ONYC_MINT, owner), mint: FOGO_ONYC_MINT },
  ]
}

/**
 * Page of burn rows from a single ATA. Returned signatures are oldest
 * cursor included so the caller can pass it back as `before` for the
 * next page. `null` cursor on the first call.
 */
export interface BurnPage {
  rows: BurnRow[]
  /** Signature of the oldest tx in this page. Use as `before` cursor for the next page. Null if no more results. */
  nextCursor: string | null
}

export async function fetchBurnPage(
  connection: Connection,
  binding: AtaBinding,
  cursor: string | undefined,
): Promise<BurnPage> {
  const sigs = await connection.getSignaturesForAddress(
    binding.ata,
    { limit: RPC_PAGE_SIZE, before: cursor },
    'finalized',
  )

  if (sigs.length === 0) {
    return { rows: [], nextCursor: null }
  }

  // Parallel fetch — RPC tolerates ~50-wide bursts; if rate-limited
  // the caller's TanStack Query retry will back off the whole page.
  const txs = await Promise.all(
    sigs.map(s =>
      connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'finalized',
      }),
    ),
  )

  const rows: BurnRow[] = []
  for (let i = 0; i < sigs.length; i++) {
    const sigInfo = sigs[i]
    const tx = txs[i]
    const burn = extractBurnRow(tx, sigInfo.signature, sigInfo.blockTime ?? null, sigInfo.slot, binding)
    if (burn !== null) {
      rows.push(burn)
    }
  }

  return {
    rows,
    nextCursor: sigs.length === RPC_PAGE_SIZE ? sigs[sigs.length - 1].signature : null,
  }
}

/**
 * Pure: given one parsed tx, decide whether it's a user burn from
 * `binding.ata`. Returns the BurnRow or null.
 *
 * Acceptance criteria:
 *   - `tx.meta.err === null` (failed bridges excluded)
 *   - At least one program in `accountKeys` is on PROGRAM_ALLOWLIST
 *   - Signed delta on this ATA is negative (it's a burn)
 */
export function extractBurnRow(
  tx: ParsedTransactionWithMeta | null,
  signature: string,
  blockTime: number | null,
  slot: number,
  binding: AtaBinding,
): BurnRow | null {
  if (tx === null || tx.meta === null || tx.meta.err !== null) {
    return null
  }

  // Allowlist check. For v0 txs that use an Address Lookup Table
  // (the deposit path does — see `scripts/deploy-fogo-deposit-lut.mjs`),
  // the NTT manager program ID is loaded via the LUT and lives in
  // `tx.meta.loadedAddresses`, NOT in `transaction.message.accountKeys`.
  // Without scanning both, every LUT-using deposit silently gets dropped
  // here and the user sees an empty history.
  const staticKeys = tx.transaction.message.accountKeys.map(k => k.pubkey.toBase58())
  const loaded = tx.meta.loadedAddresses
  const loadedKeys = [
    ...(loaded?.writable?.map(k => k.toString()) ?? []),
    ...(loaded?.readonly?.map(k => k.toString()) ?? []),
  ]
  const allKeys = [...staticKeys, ...loadedKeys]
  if (!allKeys.some(k => PROGRAM_ALLOWLIST.has(k))) {
    return null
  }

  const ataB58 = binding.ata.toBase58()
  const pre = tx.meta.preTokenBalances?.find(b => keysAt(tx, b.accountIndex) === ataB58)
  const post = tx.meta.postTokenBalances?.find(b => keysAt(tx, b.accountIndex) === ataB58)

  if (pre === undefined && post === undefined) {
    return null
  }

  const preAmt = BigInt(pre?.uiTokenAmount.amount ?? '0')
  const postAmt = BigInt(post?.uiTokenAmount.amount ?? '0')
  const delta = postAmt - preAmt

  // Negative delta = burn. Receives (positive delta) are dropped here;
  // they're not their own rows. Zero deltas are tx noise.
  if (delta >= 0n) {
    return null
  }

  return {
    signature,
    ata: binding.ata,
    mint: binding.mint,
    amountRaw: -delta,
    blockTime: blockTime ?? 0,
    slot,
  }
}

function keysAt(tx: ParsedTransactionWithMeta, index: number): string | undefined {
  return tx.transaction.message.accountKeys[index]?.pubkey.toBase58()
}
