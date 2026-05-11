import type { Connection } from '@solana/web3.js'
import { Buffer } from 'node:buffer'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { synthOfferBuffer } from '../../src/relayer/onre-nav'
import { quoteRedeemOnycRecovery } from '../../src/relayer/redeem-onyc-quote'

/**
 * Quoter is the composition layer: live-RPC `getAccountInfo` for the
 * Offer + mints, plus a Jupiter HTTP call. Both are mocked here — the
 * pure math is already covered by `onre-nav.test.ts`. These tests pin
 * the *integration shape*: what verdict each scenario produces.
 *
 * Deploy-readiness invariants this suite enforces:
 *  - The quoter passes the relayer authority PDA (not the mint sentinel)
 *    to Jupiter as `userPublicKey`; we verify by mock-fetch inspection.
 *  - Hung RPC / Jupiter calls surface as `quote_failed` /
 *    `offer_unavailable` — never freeze the caller.
 */

const ONRE_PROGRAM_ID = new PublicKey('onreuGhHHgVzMWSkj2oQDLDtvvGvoepBPkqyaubFcwe')
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const ONYC_MINT = new PublicKey('oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa')
// Fixed sentinel for the relayer authority PDA — the exact value doesn't
// matter to the floor math, only that it's threaded through to Jupiter
// instead of being substituted with one of the mints.
const RELAYER_AUTHORITY_PDA = new PublicKey('11111111111111111111111111111113')
const RPC_TIMEOUT_MS = 5_000

function buildMintBuffer(decimals: number): Buffer {
  // SPL Mint layout: 82 bytes; decimals at offset 44.
  const data = Buffer.alloc(82)
  data.writeUInt8(decimals, 44)
  // is_initialized at offset 45.
  data.writeUInt8(1, 45)
  return data
}

function makeMockConnection(opts: {
  offerData: Uint8Array
  usdcDecimals: number
  onycDecimals: number
}): Connection {
  return {
    async getAccountInfo(key: PublicKey) {
      const k = key.toBase58()
      if (k === USDC_MINT.toBase58()) {
        return { data: buildMintBuffer(opts.usdcDecimals), executable: false, lamports: 1, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), rentEpoch: 0 }
      }
      if (k === ONYC_MINT.toBase58()) {
        return { data: buildMintBuffer(opts.onycDecimals), executable: false, lamports: 1, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), rentEpoch: 0 }
      }
      // Treat any other pubkey as the offer PDA.
      return { data: Buffer.from(opts.offerData), executable: false, lamports: 1, owner: ONRE_PROGRAM_ID, rentEpoch: 0 }
    },
  } as unknown as Connection
}

/**
 * Mock Jupiter v6 transport. The `seenUserPublicKey` ref captures what
 * the SDK forwarded as `userPublicKey` on the `/swap-instructions` POST
 * body — used by the authority-PDA-threading test below.
 */
function makeMockJupiterFetch(
  quotedOut: bigint,
  seenUserPublicKey?: { value: string | undefined },
): typeof fetch {
  const SHARED_ACCOUNTS_ROUTE_DISC = Buffer.from([193, 32, 155, 51, 65, 214, 156, 129])
  const ixData = Buffer.concat([SHARED_ACCOUNTS_ROUTE_DISC, Buffer.alloc(16)])
  return (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === 'string' ? input : String(input)
    if (url.includes('/v6/quote')) {
      return {
        ok: true,
        async json() {
          return { outAmount: quotedOut.toString(), routePlan: [] }
        },
      } as unknown as Response
    }
    if (url.includes('/v6/swap-instructions')) {
      if (init?.body && seenUserPublicKey) {
        try {
          const parsed = JSON.parse(init.body) as { userPublicKey?: string }
          seenUserPublicKey.value = parsed.userPublicKey
        } catch {
          // ignore — body inspection is best-effort
        }
      }
      return {
        ok: true,
        async json() {
          return {
            swapInstruction: {
              programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
              accounts: [
                { pubkey: '11111111111111111111111111111112', isSigner: false, isWritable: false },
              ],
              data: ixData.toString('base64'),
            },
            addressLookupTableAddresses: [],
          }
        },
      } as unknown as Response
    }
    throw new Error(`unexpected url: ${url}`)
  }) as unknown as typeof fetch
}

function buildOffer(now: bigint): Uint8Array {
  // One vector that snaps to base_price exactly (apr=0) — keeps the
  // expected math obvious for assertions.
  return synthOfferBuffer([
    {
      start_time: now - 1_000n,
      base_time: now - 1_000n,
      base_price: 1_000_000_000n, // 1.0 in 1e9 fixed-point
      apr: 0n,
      price_fix_duration: 86_400n,
    },
  ])
}

describe('quoteRedeemOnycRecovery', () => {
  const now = 1_800_000_000n
  const onycAmountIn = 1_000_000n // 1.0 ONyc (6 dp)

  it('returns clears_floor=true when Jupiter quotes above NAV floor', async () => {
    // At price=1.0, equal decimals, gross=1_000_000. floor at 50 bps = 995_000.
    // Quote 999_000 > 995_000 → clears floor.
    const result = await quoteRedeemOnycRecovery({
      connection: makeMockConnection({ offerData: buildOffer(now), usdcDecimals: 6, onycDecimals: 6 }),
      usdcMint: USDC_MINT,
      onycMint: ONYC_MINT,
      relayerAuthorityPda: RELAYER_AUTHORITY_PDA,
      onycAmountIn,
      nowUnix: now,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      fetchImpl: makeMockJupiterFetch(999_000n),
    })

    if (result.decision !== 'quoted') {
      throw new Error(`expected quoted, got ${result.decision}`)
    }
    expect(result.navFloor).toBe(995_000n)
    expect(result.grossExpected).toBe(1_000_000n)
    expect(result.quotedOut).toBe(999_000n)
    expect(result.clearsFloor).toBe(true)
  })

  it('returns clears_floor=false when Jupiter quotes below NAV floor', async () => {
    // Quote 994_999 < floor 995_000 → does NOT clear.
    const result = await quoteRedeemOnycRecovery({
      connection: makeMockConnection({ offerData: buildOffer(now), usdcDecimals: 6, onycDecimals: 6 }),
      usdcMint: USDC_MINT,
      onycMint: ONYC_MINT,
      relayerAuthorityPda: RELAYER_AUTHORITY_PDA,
      onycAmountIn,
      nowUnix: now,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      fetchImpl: makeMockJupiterFetch(994_999n),
    })

    expect(result.decision).toBe('quoted')
    if (result.decision !== 'quoted') {
      return
    }
    expect(result.clearsFloor).toBe(false)
    expect(result.quotedOut).toBe(994_999n)
    expect(result.navFloor).toBe(995_000n)
  })

  it('threads the relayer authority PDA through to Jupiter as userPublicKey', async () => {
    // Critical: if this regresses (e.g. someone re-introduces the mint
    // sentinel), the SDK builds the route for the wrong signer AND its
    // signer-bit sanitizer no-ops, producing a route that an auto-fire
    // path could not submit. Catch the regression at the unit level.
    const seen: { value: string | undefined } = { value: undefined }
    await quoteRedeemOnycRecovery({
      connection: makeMockConnection({ offerData: buildOffer(now), usdcDecimals: 6, onycDecimals: 6 }),
      usdcMint: USDC_MINT,
      onycMint: ONYC_MINT,
      relayerAuthorityPda: RELAYER_AUTHORITY_PDA,
      onycAmountIn,
      nowUnix: now,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      fetchImpl: makeMockJupiterFetch(999_000n, seen),
    })
    expect(seen.value).toBe(RELAYER_AUTHORITY_PDA.toBase58())
    // And specifically NOT one of the mints — guard against the prior
    // `userPublicKey: onycMint` sentinel returning.
    expect(seen.value).not.toBe(ONYC_MINT.toBase58())
    expect(seen.value).not.toBe(USDC_MINT.toBase58())
  })

  it('returns quote_failed when Jupiter HTTP throws', async () => {
    const failingFetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch

    const result = await quoteRedeemOnycRecovery({
      connection: makeMockConnection({ offerData: buildOffer(now), usdcDecimals: 6, onycDecimals: 6 }),
      usdcMint: USDC_MINT,
      onycMint: ONYC_MINT,
      relayerAuthorityPda: RELAYER_AUTHORITY_PDA,
      onycAmountIn,
      nowUnix: now,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      fetchImpl: failingFetch,
    })

    expect(result.decision).toBe('quote_failed')
    if (result.decision !== 'quote_failed') {
      return
    }
    // NAV floor should still be computed from on-chain Offer alone.
    expect(result.navFloor).toBe(995_000n)
    expect(result.reason).toMatch(/network down/i)
  })

  it('returns quote_failed when Jupiter hangs past the timeout', async () => {
    // Deploy-readiness invariant: a stuck Jupiter endpoint must not
    // freeze the cranker tick. We pass a 50ms timeout against a fetch
    // that never resolves, and expect the typed downgrade.
    const hangingFetch = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch

    const result = await quoteRedeemOnycRecovery({
      connection: makeMockConnection({ offerData: buildOffer(now), usdcDecimals: 6, onycDecimals: 6 }),
      usdcMint: USDC_MINT,
      onycMint: ONYC_MINT,
      relayerAuthorityPda: RELAYER_AUTHORITY_PDA,
      onycAmountIn,
      nowUnix: now,
      rpcTimeoutMs: 50,
      fetchImpl: hangingFetch,
    })

    expect(result.decision).toBe('quote_failed')
    if (result.decision !== 'quote_failed') {
      return
    }
    expect(result.reason).toMatch(/timeout/i)
  })

  it('returns offer_unavailable when on-chain Offer cannot be parsed', async () => {
    const badConn = {
      async getAccountInfo(key: PublicKey) {
        if (key.equals(USDC_MINT) || key.equals(ONYC_MINT)) {
          return { data: buildMintBuffer(6), executable: false, lamports: 1, owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), rentEpoch: 0 }
        }
        return null // offer missing
      },
    } as unknown as Connection

    const result = await quoteRedeemOnycRecovery({
      connection: badConn,
      usdcMint: USDC_MINT,
      onycMint: ONYC_MINT,
      relayerAuthorityPda: RELAYER_AUTHORITY_PDA,
      onycAmountIn,
      nowUnix: now,
      rpcTimeoutMs: RPC_TIMEOUT_MS,
      fetchImpl: makeMockJupiterFetch(1n),
    })

    expect(result.decision).toBe('offer_unavailable')
  })
})
