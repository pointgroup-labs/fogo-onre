import { PublicKey } from '@solana/web3.js'
import { accountDiscriminator } from '../utils/discriminators'

/**
 * Borsh decoders for the NTT v3 `Config` and `InboxItem` accounts.
 *
 * Hand-written rather than using Anchor's `BorshAccountsCoder` so the
 * SDK doesn't have to ship the NTT IDL as a runtime dependency.
 * Verified against `@wormhole-foundation/sdk-solana-ntt`'s
 * `idl/3_0_0/json/example_native_token_transfers.json`.
 */

const CONFIG_DISCRIMINATOR = accountDiscriminator('Config')
const INBOX_ITEM_DISCRIMINATOR = accountDiscriminator('InboxItem')

export type NttManagerMode = 'Locking' | 'Burning'

export interface NttConfig {
  bump: number
  owner: PublicKey
  pendingOwner: PublicKey | null
  mint: PublicKey
  tokenProgram: PublicKey
  mode: NttManagerMode
  chainId: number
  nextTransceiverId: number
  threshold: number
  enabledTransceivers: bigint
  paused: boolean
  custody: PublicKey
}

export type NttInboxReleaseStatus
  = | { kind: 'NotApproved' }
    | { kind: 'ReleaseAfter', timestamp: bigint }
    | { kind: 'Released' }

export interface NttInboxItem {
  init: boolean
  bump: number
  amount: bigint
  recipientAddress: PublicKey
  votes: bigint
  releaseStatus: NttInboxReleaseStatus
}

class Reader {
  offset = 0
  constructor(public buf: Buffer) {}
  u8(): number {
    const v = this.buf.readUInt8(this.offset)
    this.offset += 1
    return v
  }

  u16(): number {
    const v = this.buf.readUInt16LE(this.offset)
    this.offset += 2
    return v
  }

  u64(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset)
    this.offset += 8
    return v
  }

  u128(): bigint {
    const lo = this.buf.readBigUInt64LE(this.offset)
    const hi = this.buf.readBigUInt64LE(this.offset + 8)
    this.offset += 16
    return (hi << 64n) | lo
  }

  i64(): bigint {
    const v = this.buf.readBigInt64LE(this.offset)
    this.offset += 8
    return v
  }

  bool(): boolean {
    return this.u8() !== 0
  }

  pubkey(): PublicKey {
    const v = new PublicKey(this.buf.subarray(this.offset, this.offset + 32))
    this.offset += 32
    return v
  }

  optionPubkey(): PublicKey | null {
    return this.bool() ? this.pubkey() : null
  }
}

function checkDiscriminator(data: Buffer, expected: Uint8Array, label: string): void {
  if (data.length < 8) {
    throw new Error(`${label}: account too short (${data.length} bytes)`)
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expected[i]) {
      throw new Error(
        `${label}: discriminator mismatch — expected ${Buffer.from(expected).toString('hex')}, got ${data.subarray(0, 8).toString('hex')}`,
      )
    }
  }
}

export function decodeNttConfig(data: Buffer): NttConfig {
  checkDiscriminator(data, CONFIG_DISCRIMINATOR, 'NttConfig')
  const r = new Reader(data.subarray(8))
  const bump = r.u8()
  const owner = r.pubkey()
  const pendingOwner = r.optionPubkey()
  const mint = r.pubkey()
  const tokenProgram = r.pubkey()
  const modeByte = r.u8()
  let mode: NttManagerMode
  switch (modeByte) {
    case 0:
      mode = 'Locking'
      break
    case 1:
      mode = 'Burning'
      break
    default:
      throw new Error(`NttConfig: unknown mode byte ${modeByte}`)
  }
  const chainId = r.u16()
  const nextTransceiverId = r.u8()
  const threshold = r.u8()
  const enabledTransceivers = r.u128()
  const paused = r.bool()
  const custody = r.pubkey()
  return {
    bump,
    owner,
    pendingOwner,
    mint,
    tokenProgram,
    mode,
    chainId,
    nextTransceiverId,
    threshold,
    enabledTransceivers,
    paused,
    custody,
  }
}

export function decodeNttInboxItem(data: Buffer): NttInboxItem {
  checkDiscriminator(data, INBOX_ITEM_DISCRIMINATOR, 'NttInboxItem')
  const r = new Reader(data.subarray(8))
  const init = r.bool()
  const bump = r.u8()
  const amount = r.u64()
  const recipientAddress = r.pubkey()
  const votes = r.u128()
  const tag = r.u8()
  let releaseStatus: NttInboxReleaseStatus
  switch (tag) {
    case 0:
      releaseStatus = { kind: 'NotApproved' }
      break
    case 1:
      releaseStatus = { kind: 'ReleaseAfter', timestamp: r.i64() }
      break
    case 2:
      releaseStatus = { kind: 'Released' }
      break
    default:
      throw new Error(`NttInboxItem: unknown ReleaseStatus tag ${tag}`)
  }
  return { init, bump, amount, recipientAddress, votes, releaseStatus }
}

export const NTT_CONFIG_DISCRIMINATOR = CONFIG_DISCRIMINATOR
export const NTT_INBOX_ITEM_DISCRIMINATOR = INBOX_ITEM_DISCRIMINATOR
