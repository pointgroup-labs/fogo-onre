/**
 * `findUserInboxWithMinPda` must encode `minOut` as a u64 little-endian seed
 * (matching the Rust `min.to_le_bytes()` the relayer re-derives) using only
 * browser-portable APIs. The webapp's Buffer polyfill lacks the BigInt method
 * `writeBigUInt64LE`, so the derivation must not depend on it — else deposit
 * throws `minLe.writeBigUInt64LE is not a function`. Wrong endianness would be
 * worse: a silently mismatched recipient PDA the relayer can never match.
 */
import { findUserInboxWithMinPda, RELAYER_PROGRAM_ID, USER_INBOX_SEED } from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

describe('findUserInboxWithMinPda', () => {
  const wallet = new PublicKey('tiaModT7KBWK1hNLFu94FogDGMs1haBZTupHujGzKLA')

  it('encodes minOut as u64 little-endian (matches Rust to_le_bytes)', () => {
    const minOut = 0x0102030405060708n
    const expectedLe = new Uint8Array([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01])
    const [expected] = PublicKey.findProgramAddressSync(
      [USER_INBOX_SEED, wallet.toBuffer(), expectedLe],
      RELAYER_PROGRAM_ID,
    )
    const [actual] = findUserInboxWithMinPda(wallet, minOut, RELAYER_PROGRAM_ID)
    expect(actual.toBase58()).toBe(expected.toBase58())
  })

  it('does not depend on Buffer BigInt methods (browser-safe)', () => {
    const original = Buffer.prototype.writeBigUInt64LE
    // Simulate the webapp's old Buffer polyfill, which lacks the BigInt writes.
    delete (Buffer.prototype as { writeBigUInt64LE?: unknown }).writeBigUInt64LE
    try {
      expect(() => findUserInboxWithMinPda(wallet, 400_000n)).not.toThrow()
    } finally {
      Buffer.prototype.writeBigUInt64LE = original
    }
  })

  it('derives distinct PDAs for distinct floors', () => {
    const [a] = findUserInboxWithMinPda(wallet, 1n)
    const [b] = findUserInboxWithMinPda(wallet, 2n)
    expect(a.toBase58()).not.toBe(b.toBase58())
  })
})
