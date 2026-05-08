import { describe, expect, it } from 'vitest'
import { readNttInboxAmount, readSplTokenAmount } from '../../src/relayer/account-layouts'

// SPL TokenAccount layout: mint(32) | owner(32) | amount(u64 LE) | delegate_opt(36) | state(1) | ...
// Min len = 64 + 8 = 72 (we don't read past `amount`).
function spl(amount: bigint, len = 72): Buffer {
  const buf = Buffer.alloc(len)
  if (len >= 72) {
    buf.writeBigUInt64LE(amount, 64)
  }
  return buf
}

// NTT InboxItem layout: discriminator(8) | init(1) | bump(1) | amount(u64 LE) | ...
// Min len = 10 + 8 = 18.
function inbox(amount: bigint, len = 18): Buffer {
  const buf = Buffer.alloc(len)
  if (len >= 18) {
    buf.writeBigUInt64LE(amount, 10)
  }
  return buf
}

describe('account-layouts', () => {
  describe('readSplTokenAmount', () => {
    it('reads u64 LE at offset 64', () => {
      expect(readSplTokenAmount(spl(0n))).toBe(0n)
      expect(readSplTokenAmount(spl(1n))).toBe(1n)
      expect(readSplTokenAmount(spl(123_456_789n))).toBe(123_456_789n)
      expect(readSplTokenAmount(spl(0xFFFF_FFFF_FFFF_FFFFn))).toBe(0xFFFF_FFFF_FFFF_FFFFn)
    })

    it('returns null for short buffers (uninitialized account)', () => {
      expect(readSplTokenAmount(undefined)).toBe(null)
      expect(readSplTokenAmount(null)).toBe(null)
      expect(readSplTokenAmount(Buffer.alloc(0))).toBe(null)
      expect(readSplTokenAmount(Buffer.alloc(71))).toBe(null) // one byte short
    })

    it('accepts Uint8Array as well as Buffer', () => {
      const u8 = new Uint8Array(spl(42n))
      expect(readSplTokenAmount(u8)).toBe(42n)
    })
  })

  describe('readNttInboxAmount', () => {
    it('reads u64 LE at offset 10', () => {
      expect(readNttInboxAmount(inbox(0n))).toBe(0n)
      expect(readNttInboxAmount(inbox(1n))).toBe(1n)
      expect(readNttInboxAmount(inbox(987_654_321n))).toBe(987_654_321n)
    })

    it('returns null for short buffers', () => {
      expect(readNttInboxAmount(undefined)).toBe(null)
      expect(readNttInboxAmount(null)).toBe(null)
      expect(readNttInboxAmount(Buffer.alloc(17))).toBe(null) // one byte short
    })

    it('accepts Uint8Array as well as Buffer', () => {
      const u8 = new Uint8Array(inbox(7n))
      expect(readNttInboxAmount(u8)).toBe(7n)
    })
  })

  // Pre-flight 3 in claim_usdc.ts compares these two values against
  // the on-chain handler's `user_inbox_ata.amount >= inbox.amount`
  // assertion. Encode the four cases of that comparison here so a
  // layout drift fails this test loudly before the cranker would
  // start spamming on-chain failures.
  describe('pre-flight 3 comparison cases', () => {
    it('inbox missing → caller proceeds (null skips the guard)', () => {
      expect(readNttInboxAmount(null)).toBe(null)
    })
    it('inbox present, ata missing → ata defaults to 0n at the callsite', () => {
      expect(readNttInboxAmount(inbox(100n))).toBe(100n)
      expect(readSplTokenAmount(null)).toBe(null) // callsite uses `?? 0n`
    })
    it('inbox=100, ata=50 → insufficient (50 < 100)', () => {
      const inboxAmt = readNttInboxAmount(inbox(100n))!
      const ataAmt = readSplTokenAmount(spl(50n))!
      expect(ataAmt < inboxAmt).toBe(true)
    })
    it('inbox=100, ata=150 → sufficient (150 >= 100)', () => {
      const inboxAmt = readNttInboxAmount(inbox(100n))!
      const ataAmt = readSplTokenAmount(spl(150n))!
      expect(ataAmt < inboxAmt).toBe(false)
    })
  })
})
