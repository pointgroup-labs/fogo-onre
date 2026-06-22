import { Buffer } from 'node:buffer'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'

/** SPL Memo program — the canonical on-chain note rail (no accounts, UTF-8 data). */
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

/**
 * Wire prefix for the user-signed swap floor. Full memo: `<prefix><u64-decimal>`.
 * Kept short — the memo program is a static key (program IDs can't be LUT-
 * compressed), so the inline data is the only lever for the 1232-byte tx limit.
 */
export const MIN_SWAP_OUT_MEMO_PREFIX = 'onre:mso:'

const U64_MAX = (1n << 64n) - 1n

/** `0` or a digit string with no leading zero — the only u64 decimal we accept. */
const CANONICAL_U64 = /^(?:0|[1-9]\d*)$/

/**
 * Build the SPL Memo ix carrying the user-signed swap floor for the cranker.
 * The cranker reads it off the FOGO bridge tx and feeds it to `receive`; the
 * value is untrusted (wrong → recipient-PDA mismatch → revert, no skim).
 */
export function buildMinSwapOutMemoIx(minSwapOut: bigint): TransactionInstruction {
  if (minSwapOut <= 0n || minSwapOut > U64_MAX) {
    throw new Error(`min_swap_out must be a positive u64 (on-chain rejects 0): ${minSwapOut}`)
  }
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(`${MIN_SWAP_OUT_MEMO_PREFIX}${minSwapOut}`, 'utf8'),
  })
}

/**
 * Parse a memo string back to the floor, or null if it isn't our exact wire
 * format. Strict: exact prefix, canonical decimal u64 (no sign, padding,
 * radix prefix, or whitespace). The strictness is load-bearing — a lax parse
 * could feed `receive` a value that derives the wrong PDA.
 */
export function parseMinSwapOutMemo(memoText: string): bigint | null {
  if (!memoText.startsWith(MIN_SWAP_OUT_MEMO_PREFIX)) {
    return null
  }
  const body = memoText.slice(MIN_SWAP_OUT_MEMO_PREFIX.length)
  if (!CANONICAL_U64.test(body)) {
    return null
  }
  const value = BigInt(body)
  return value > U64_MAX ? null : value
}
