'use client'

/**
 * On-chain liveness check for a FOGO session before a paymaster submit.
 *
 * FOGO's patched token program rejects any session-authorized debit when
 * the backing `Session` account is revoked/expired/invalid, surfacing as
 * `custom program error 0xee6b2809` ("Error: Unknown") deep inside the
 * bridge CPI — which the paymaster returns to us as an opaque 502.
 * `isEstablished()` only reflects the browser's cached session keypair,
 * not chain state, so a session revoked out-of-band still reads as
 * connected. This reads the real account and lets callers fail fast with a
 * reconnect prompt. Fail-open: anything we can't positively decode as dead
 * is treated as live so we never block a working submit.
 */

import type { Connection, PublicKey } from '@solana/web3.js'

/**
 * Session manager program that owns every `Session` account. Used only to
 * reject foreign-owned accounts; reads are by pubkey.
 */
const SESSION_MANAGER_PROGRAM_ID = 'SesswvJ7puvAgpyqp7N8HnjNnvpnS8447tKNF3sPgbC'

/**
 * `Session` account layout (verified against the session-manager IDL):
 * 8-byte disc, `sponsor` pubkey (32), `major` u8, then a `SessionInfo`
 * enum: tag 0 `Invalid`, 1 `V1` (always-active), 2/3/4 `V2`/`V3`/`V4`
 * (each an inner `Revoked(0)`/`Active(1)` enum). The active payload starts
 * with `ActiveSessionInfo { user: pubkey, expiration: i64, … }`; V4 wraps
 * it behind a 32-byte `domain_hash`. We decode only the discriminators and
 * `expiration` — enough to gate a submit.
 */
const SPONSOR_LEN = 32
const SESSION_INFO_TAG_OFFSET = 8 + SPONSOR_LEN + 1 // disc + sponsor + major

export type SessionLiveness
  = | { kind: 'active', expirationMs: number }
    | { kind: 'expired', expirationMs: number }
    | { kind: 'revoked' }
    | { kind: 'invalid' }
    | { kind: 'missing' }
  /** Foreign owner or unrecognized layout — caller should fail open. */
    | { kind: 'unknown' }

/**
 * Reads and decodes the `Session` account at `sessionPublicKey`. Never
 * throws; returns a `SessionLiveness` the caller interprets.
 */
export async function checkSessionLiveness(
  connection: Connection,
  sessionPublicKey: PublicKey,
): Promise<SessionLiveness> {
  let account: Awaited<ReturnType<Connection['getAccountInfo']>>
  try {
    account = await connection.getAccountInfo(sessionPublicKey, 'confirmed')
  } catch {
    return { kind: 'unknown' }
  }
  if (account === null) {
    return { kind: 'missing' }
  }
  if (account.owner.toBase58() !== SESSION_MANAGER_PROGRAM_ID) {
    return { kind: 'unknown' }
  }
  return decodeSessionLiveness(account.data)
}

function decodeSessionLiveness(data: Buffer | Uint8Array): SessionLiveness {
  const buf = Buffer.from(data)
  if (buf.length < SESSION_INFO_TAG_OFFSET + 1) {
    return { kind: 'unknown' }
  }
  const sessionInfoTag = buf[SESSION_INFO_TAG_OFFSET]

  if (sessionInfoTag === 0) {
    return { kind: 'invalid' }
  }

  // V1 is the always-active variant with no inner Revoked enum: the
  // `ActiveSessionInfo` payload follows the tag directly.
  if (sessionInfoTag === 1) {
    return finishActive(buf, SESSION_INFO_TAG_OFFSET + 1, false)
  }

  // V2/V3/V4 wrap an inner Revoked(0)/Active(1) enum.
  if (sessionInfoTag === 2 || sessionInfoTag === 3 || sessionInfoTag === 4) {
    const innerTagOffset = SESSION_INFO_TAG_OFFSET + 1
    if (buf.length < innerTagOffset + 1) {
      return { kind: 'unknown' }
    }
    const innerTag = buf[innerTagOffset]
    if (innerTag === 0) {
      return { kind: 'revoked' }
    }
    if (innerTag !== 1) {
      return { kind: 'unknown' }
    }
    // V4's active payload is `ActiveSessionInfoWithDomainHash`, prefixed
    // by a 32-byte domain hash before the `ActiveSessionInfo`.
    const hasDomainHash = sessionInfoTag === 4
    return finishActive(buf, innerTagOffset + 1, hasDomainHash)
  }

  return { kind: 'unknown' }
}

/**
 * Reads `ActiveSessionInfo.expiration` and classifies active vs expired.
 * `payloadOffset` points at the start of the active payload (the optional
 * V4 domain hash, then `user` pubkey, then the i64 expiration).
 */
function finishActive(buf: Buffer, payloadOffset: number, hasDomainHash: boolean): SessionLiveness {
  const userOffset = payloadOffset + (hasDomainHash ? 32 : 0)
  const expirationOffset = userOffset + 32
  if (buf.length < expirationOffset + 8) {
    return { kind: 'unknown' }
  }
  const expirationMs = Number(readBigInt64LE(buf, expirationOffset)) * 1000
  if (expirationMs <= Date.now()) {
    return { kind: 'expired', expirationMs }
  }
  return { kind: 'active', expirationMs }
}

/**
 * Little-endian signed i64 read. Hand-rolled because the browser's
 * `Buffer` polyfill (Next.js shims `buffer`) omits Node's
 * `readBigInt64LE`; `BigInt` bit-ops behave identically everywhere.
 */
function readBigInt64LE(buf: Uint8Array, offset: number): bigint {
  let unsigned = 0n
  for (let i = 0; i < 8; i++) {
    unsigned |= BigInt(buf[offset + i]) << BigInt(8 * i)
  }
  // Reinterpret the top bit as the two's-complement sign.
  return unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned
}

/**
 * Throws a reconnect-prompting error when the session is positively dead
 * (revoked / expired / invalid / missing). No-ops on `active` and on
 * `unknown` (fail-open) so a layout change can never block a live submit.
 */
export async function assertSessionActive(
  connection: Connection,
  sessionPublicKey: PublicKey,
): Promise<void> {
  const liveness = await checkSessionLiveness(connection, sessionPublicKey)
  switch (liveness.kind) {
    case 'revoked':
    case 'expired':
    case 'invalid':
    case 'missing':
      throw new Error('Your session ended. Disconnect and reconnect to continue.')
    case 'active':
    case 'unknown':
  }
}
