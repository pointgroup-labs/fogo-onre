/**
 * Fixed-offset readers for the third-party account layouts the cranker
 * peeks into for pre-flight checks. These mirror upstream ABIs:
 *
 *   - SPL TokenAccount: mint(32) | owner(32) | amount(u64 LE) | ...
 *   - NTT InboxItem:    discriminator(8) | init(1) | bump(1) | amount(u64 LE) | ...
 *
 * The sha256 binary pins in `tests/utils/withdraw-scaffolding.ts`
 * (`pinBinaryFixtures`) are the tripwire for upstream layout drift; when
 * those fire, refresh both the binary and these constants in lockstep.
 *
 * Returns `null` when the buffer is shorter than the expected layout —
 * caller treats that as "this account hasn't been initialized yet" rather
 * than throwing. Both pre-flights in `claim-usdc.ts` are advisory: a
 * missing/short account just means we proceed and the on-chain handler
 * gives the authoritative answer.
 */

const SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET = 64
const SPL_TOKEN_ACCOUNT_MIN_LEN = 72

const NTT_INBOX_ITEM_AMOUNT_OFFSET = 10
const NTT_INBOX_ITEM_MIN_LEN = 18

export function readSplTokenAmount(data: Uint8Array | Buffer | undefined | null): bigint | null {
  if (!data || data.length < SPL_TOKEN_ACCOUNT_MIN_LEN) {
    return null
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return buf.readBigUInt64LE(SPL_TOKEN_ACCOUNT_AMOUNT_OFFSET)
}

export function readNttInboxAmount(data: Uint8Array | Buffer | undefined | null): bigint | null {
  if (!data || data.length < NTT_INBOX_ITEM_MIN_LEN) {
    return null
  }
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  return buf.readBigUInt64LE(NTT_INBOX_ITEM_AMOUNT_OFFSET)
}
