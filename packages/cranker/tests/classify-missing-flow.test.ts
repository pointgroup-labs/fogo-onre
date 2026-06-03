import type { AccountInfo, PublicKey } from '@solana/web3.js'
import type { AdvanceContext } from '../src/relayer/types'
import { NTT_INBOX_ITEM_DISCRIMINATOR, ONYC_MINT } from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { classifyMissingFlow } from '../src/relayer/enumerate'
import { silentLogger } from '../src/utils/log'

/** Build a `Released` NTT inbox-item buffer for the given recipient/amount. */
function inboxItemBuf(recipient: PublicKey, amount: bigint): Buffer {
  const amt = Buffer.alloc(8)
  amt.writeBigUInt64LE(amount)
  return Buffer.concat([
    Buffer.from(NTT_INBOX_ITEM_DISCRIMINATOR),
    Buffer.from([1, 255]), // init=true, bump
    amt,
    recipient.toBuffer(),
    Buffer.alloc(16), // votes u128
    Buffer.from([2]), // ReleaseStatus tag 2 = Released
  ])
}

/** Build an SPL token-account buffer holding `amount` of `mint`. */
function tokenAccountBuf(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const buf = Buffer.alloc(165)
  mint.toBuffer().copy(buf, 0)
  owner.toBuffer().copy(buf, 32)
  buf.writeBigUInt64LE(amount, 64)
  return buf
}

function fakeAccount(data: Buffer): AccountInfo<Buffer> {
  return { data, executable: false, lamports: 1, owner: Keypair.generate().publicKey, rentEpoch: 0 }
}

function makeCtx(
  byPubkey: (pk: PublicKey) => Buffer | null,
): AdvanceContext {
  return {
    connection: {
      getAccountInfo: async (pk: PublicKey) => {
        const data = byPubkey(pk)
        return data ? fakeAccount(data) : null
      },
    },
    metrics: { flowUnsweptObserved: { inc: () => {} } },
    log: silentLogger(),
  } as unknown as AdvanceContext
}

describe('classifyMissingFlow', () => {
  const inboxItem = Keypair.generate().publicKey
  const recipient = Keypair.generate().publicKey
  const amount = 200_000_000n
  const recipientAta = getAssociatedTokenAddressSync(ONYC_MINT, recipient, true)

  it('returns Pending (null) when unlocked tokens are still parked in the recipient ATA', async () => {
    // Raw NTT redeem ran (inbox Released) but the relayer has not swept —
    // the ATA still holds the full amount. Must NOT be abandoned as Closed.
    let unsweptIncCalls = 0
    const ctx = makeCtx((pk) => {
      if (pk.equals(inboxItem)) {
        return inboxItemBuf(recipient, amount)
      }
      if (pk.equals(recipientAta)) {
        return tokenAccountBuf(ONYC_MINT, recipient, amount)
      }
      return null
    })
    ;(ctx.metrics as unknown as { flowUnsweptObserved: { inc: () => void } }).flowUnsweptObserved = {
      inc: () => { unsweptIncCalls++ },
    }
    expect(await classifyMissingFlow(ctx, 'withdraw', inboxItem)).toBeNull()
    expect(unsweptIncCalls).toBe(1)
  })

  it('returns Closed when the recipient ATA has been swept (balance 0)', async () => {
    const ctx = makeCtx((pk) => {
      if (pk.equals(inboxItem)) {
        return inboxItemBuf(recipient, amount)
      }
      if (pk.equals(recipientAta)) {
        return tokenAccountBuf(ONYC_MINT, recipient, 0n)
      }
      return null
    })
    expect(await classifyMissingFlow(ctx, 'withdraw', inboxItem)).toBe('Closed')
  })

  it('returns Pending (null) when the inbox-item does not exist yet', async () => {
    const ctx = makeCtx(() => null)
    expect(await classifyMissingFlow(ctx, 'withdraw', inboxItem)).toBeNull()
  })

  it('returns Pending (null) on a transient inbox-item RPC failure', async () => {
    const ctx = {
      connection: { getAccountInfo: async () => { throw new Error('rpc blip') } },
      log: silentLogger(),
    } as unknown as AdvanceContext
    expect(await classifyMissingFlow(ctx, 'withdraw', inboxItem)).toBeNull()
  })
})
