/**
 * Decoder fixture tests for the SDK's NTT Config / InboxItem decoders.
 * Hand-encode known values, run through the decoder, assert round-trip.
 * No on-chain dependency — pure byte-layout coverage.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import {
  decodeNttConfig,
  decodeNttInboxItem,
  type NttManagerMode,
} from '@fogo-onre/sdk'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'

function disc(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8))
}

function encodeConfig(args: {
  bump: number
  owner: Buffer
  pendingOwner: Buffer | null
  mint: Buffer
  tokenProgram: Buffer
  mode: 0 | 1
  chainId: number
  nextTransceiverId: number
  threshold: number
  enabledTransceivers: bigint
  paused: boolean
  custody: Buffer
}): Buffer {
  const parts: Buffer[] = [
    disc('Config'),
    Buffer.from([args.bump]),
    args.owner,
    args.pendingOwner ? Buffer.concat([Buffer.from([1]), args.pendingOwner]) : Buffer.from([0]),
    args.mint,
    args.tokenProgram,
    Buffer.from([args.mode]),
    (() => { const b = Buffer.alloc(2); b.writeUInt16LE(args.chainId); return b })(),
    Buffer.from([args.nextTransceiverId]),
    Buffer.from([args.threshold]),
    (() => {
      const b = Buffer.alloc(16)
      b.writeBigUInt64LE(args.enabledTransceivers & ((1n << 64n) - 1n), 0)
      b.writeBigUInt64LE(args.enabledTransceivers >> 64n, 8)
      return b
    })(),
    Buffer.from([args.paused ? 1 : 0]),
    args.custody,
  ]
  return Buffer.concat(parts)
}

describe('decodeNttConfig', () => {
  const owner = Keypair.generate().publicKey
  const mint = Keypair.generate().publicKey
  const tokenProgram = Keypair.generate().publicKey
  const custody = Keypair.generate().publicKey

  it('round-trips Burning mode with no pendingOwner', () => {
    const buf = encodeConfig({
      bump: 250,
      owner: Buffer.from(owner.toBytes()),
      pendingOwner: null,
      mint: Buffer.from(mint.toBytes()),
      tokenProgram: Buffer.from(tokenProgram.toBytes()),
      mode: 1,
      chainId: 1,
      nextTransceiverId: 2,
      threshold: 1,
      enabledTransceivers: 1n,
      paused: false,
      custody: Buffer.from(custody.toBytes()),
    })
    const d = decodeNttConfig(buf)
    expect(d.bump).toBe(250)
    expect(d.owner.equals(owner)).toBe(true)
    expect(d.pendingOwner).toBeNull()
    expect(d.mint.equals(mint)).toBe(true)
    expect(d.tokenProgram.equals(tokenProgram)).toBe(true)
    expect(d.mode).toBe<NttManagerMode>('Burning')
    expect(d.chainId).toBe(1)
    expect(d.nextTransceiverId).toBe(2)
    expect(d.threshold).toBe(1)
    expect(d.enabledTransceivers).toBe(1n)
    expect(d.paused).toBe(false)
    expect(d.custody.equals(custody)).toBe(true)
  })

  it('round-trips Locking mode with pendingOwner set', () => {
    const pending = Keypair.generate().publicKey
    const buf = encodeConfig({
      bump: 200,
      owner: Buffer.from(owner.toBytes()),
      pendingOwner: Buffer.from(pending.toBytes()),
      mint: Buffer.from(mint.toBytes()),
      tokenProgram: Buffer.from(tokenProgram.toBytes()),
      mode: 0,
      chainId: 9999,
      nextTransceiverId: 3,
      threshold: 2,
      enabledTransceivers: (1n << 100n) | 7n,
      paused: true,
      custody: Buffer.from(custody.toBytes()),
    })
    const d = decodeNttConfig(buf)
    expect(d.mode).toBe<NttManagerMode>('Locking')
    expect(d.pendingOwner?.equals(pending)).toBe(true)
    expect(d.chainId).toBe(9999)
    expect(d.threshold).toBe(2)
    expect(d.enabledTransceivers).toBe((1n << 100n) | 7n)
    expect(d.paused).toBe(true)
  })

  it('rejects bad discriminator', () => {
    const buf = encodeConfig({
      bump: 1,
      owner: Buffer.from(owner.toBytes()),
      pendingOwner: null,
      mint: Buffer.from(mint.toBytes()),
      tokenProgram: Buffer.from(tokenProgram.toBytes()),
      mode: 1,
      chainId: 1,
      nextTransceiverId: 0,
      threshold: 1,
      enabledTransceivers: 0n,
      paused: false,
      custody: Buffer.from(custody.toBytes()),
    })
    buf[0] = 0xff
    expect(() => decodeNttConfig(buf)).toThrow(/discriminator mismatch/)
  })

  it('rejects unknown mode byte', () => {
    const buf = encodeConfig({
      bump: 1,
      owner: Buffer.from(owner.toBytes()),
      pendingOwner: null,
      mint: Buffer.from(mint.toBytes()),
      tokenProgram: Buffer.from(tokenProgram.toBytes()),
      mode: 1,
      chainId: 1,
      nextTransceiverId: 0,
      threshold: 1,
      enabledTransceivers: 0n,
      paused: false,
      custody: Buffer.from(custody.toBytes()),
    })
    // Locate mode byte: 8(disc) + 1(bump) + 32(owner) + 1(none) + 32(mint) + 32(tokenProgram) = 106
    buf[106] = 7
    expect(() => decodeNttConfig(buf)).toThrow(/unknown mode byte 7/)
  })
})

function encodeInboxItem(args: {
  init: boolean
  bump: number
  amount: bigint
  recipient: Buffer
  votes: bigint
  release: 'NotApproved' | { ReleaseAfter: bigint } | 'Released'
}): Buffer {
  const parts: Buffer[] = [
    disc('InboxItem'),
    Buffer.from([args.init ? 1 : 0]),
    Buffer.from([args.bump]),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(args.amount); return b })(),
    args.recipient,
    (() => {
      const b = Buffer.alloc(16)
      b.writeBigUInt64LE(args.votes & ((1n << 64n) - 1n), 0)
      b.writeBigUInt64LE(args.votes >> 64n, 8)
      return b
    })(),
  ]
  if (args.release === 'NotApproved') {
    parts.push(Buffer.from([0]))
  } else if (args.release === 'Released') {
    parts.push(Buffer.from([2]))
  } else {
    const b = Buffer.alloc(9)
    b.writeUInt8(1, 0)
    b.writeBigInt64LE(args.release.ReleaseAfter, 1)
    parts.push(b)
  }
  return Buffer.concat(parts)
}

describe('decodeNttInboxItem', () => {
  const recipient = Keypair.generate().publicKey

  it('round-trips NotApproved', () => {
    const buf = encodeInboxItem({
      init: true,
      bump: 254,
      amount: 1_000_000n,
      recipient: Buffer.from(recipient.toBytes()),
      votes: 1n,
      release: 'NotApproved',
    })
    const d = decodeNttInboxItem(buf)
    expect(d.init).toBe(true)
    expect(d.bump).toBe(254)
    expect(d.amount).toBe(1_000_000n)
    expect(d.recipientAddress.equals(recipient)).toBe(true)
    expect(d.votes).toBe(1n)
    expect(d.releaseStatus).toEqual({ kind: 'NotApproved' })
  })

  it('round-trips ReleaseAfter(ts)', () => {
    const buf = encodeInboxItem({
      init: true,
      bump: 100,
      amount: 42n,
      recipient: Buffer.from(recipient.toBytes()),
      votes: 3n,
      release: { ReleaseAfter: 1_700_000_000n },
    })
    const d = decodeNttInboxItem(buf)
    expect(d.releaseStatus).toEqual({ kind: 'ReleaseAfter', timestamp: 1_700_000_000n })
  })

  it('round-trips Released', () => {
    const buf = encodeInboxItem({
      init: true,
      bump: 100,
      amount: 42n,
      recipient: Buffer.from(recipient.toBytes()),
      votes: 3n,
      release: 'Released',
    })
    const d = decodeNttInboxItem(buf)
    expect(d.releaseStatus).toEqual({ kind: 'Released' })
  })
})
