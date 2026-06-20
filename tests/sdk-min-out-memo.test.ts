/**
 * Min-swap-out Memo wire format: the cranker's `min_out` delivery channel. The
 * client attaches `onre:mso:<u64-decimal>` as an SPL Memo on the FOGO bridge
 * tx; the cranker reads it back (free — it already fetches that tx for wallet
 * recovery) and feeds it to `receive`.
 *
 * The prefix is kept short on purpose: the memo program is a static key
 * (program IDs can't be LUT-compressed), so the inline payload is the only
 * lever against the 1232-byte tx limit.
 *
 * The memo is UNTRUSTED: a wrong/missing value derives the wrong recipient
 * PDA, so `receive` reverts (no skim). These tests pin the format so build
 * and parse stay in lockstep and the parser stays strict (no coercion).
 */

import {
  buildMinSwapOutMemoIx,
  MEMO_PROGRAM_ID,
  MIN_SWAP_OUT_MEMO_PREFIX,
  parseMinSwapOutMemo,
} from '@fogo-onre/sdk'
import { describe, expect, it } from 'vitest'

const U64_MAX = (1n << 64n) - 1n

describe('buildMinSwapOutMemoIx', () => {
  it('targets the SPL Memo program with no account metas', () => {
    const ix = buildMinSwapOutMemoIx(4_200_000n)
    expect(ix.programId.equals(MEMO_PROGRAM_ID)).toBe(true)
    expect(ix.keys).toHaveLength(0)
  })

  it('encodes the canonical `onre:mso:<n>` ASCII payload', () => {
    const ix = buildMinSwapOutMemoIx(4_200_000n)
    expect(ix.data.toString('utf8')).toBe('onre:mso:4200000')
    expect(MIN_SWAP_OUT_MEMO_PREFIX).toBe('onre:mso:')
  })

  it('rejects zero, negative, or out-of-u64-range values', () => {
    // On-chain `receive` rejects min_swap_out == 0; the honest builder must
    // not let a user construct a tx that can never be cranked.
    expect(() => buildMinSwapOutMemoIx(0n)).toThrow()
    expect(() => buildMinSwapOutMemoIx(-1n)).toThrow()
    expect(() => buildMinSwapOutMemoIx(U64_MAX + 1n)).toThrow()
  })
})

describe('parseMinSwapOutMemo', () => {
  it('round-trips build → decode → parse for representative values', () => {
    // Build rejects 0 (guarded), but parse must still accept `onre:mso:0`
    // (untrusted input) — see the explicit parse-0 case below.
    for (const n of [1n, 4_200_000n, U64_MAX]) {
      const text = buildMinSwapOutMemoIx(n).data.toString('utf8')
      expect(parseMinSwapOutMemo(text)).toBe(n)
    }
  })

  it('parses the canonical payload to a bigint', () => {
    expect(parseMinSwapOutMemo('onre:mso:0')).toBe(0n)
    expect(parseMinSwapOutMemo(`onre:mso:${U64_MAX}`)).toBe(U64_MAX)
  })

  it('rejects a wrong/missing/garbage prefix (incl. the retired v1 format)', () => {
    expect(parseMinSwapOutMemo('')).toBeNull()
    expect(parseMinSwapOutMemo('hello world')).toBeNull()
    expect(parseMinSwapOutMemo('onre:min_swap_out:v1:5')).toBeNull()
    expect(parseMinSwapOutMemo('onre:mso5')).toBeNull()
    expect(parseMinSwapOutMemo('xonre:mso:5')).toBeNull()
  })

  it('rejects a non-decimal, signed, or padded number body', () => {
    expect(parseMinSwapOutMemo('onre:mso:')).toBeNull()
    expect(parseMinSwapOutMemo('onre:mso:0x10')).toBeNull()
    expect(parseMinSwapOutMemo('onre:mso:-5')).toBeNull()
    expect(parseMinSwapOutMemo('onre:mso:+5')).toBeNull()
    expect(parseMinSwapOutMemo('onre:mso: 5')).toBeNull()
    expect(parseMinSwapOutMemo('onre:mso:5 ')).toBeNull()
    expect(parseMinSwapOutMemo('onre:mso:007')).toBeNull()
    expect(parseMinSwapOutMemo('onre:mso:1_000')).toBeNull()
  })

  it('rejects an overflowing u64 body', () => {
    expect(parseMinSwapOutMemo(`onre:mso:${U64_MAX + 1n}`)).toBeNull()
  })
})
