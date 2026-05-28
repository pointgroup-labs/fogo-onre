import type { Connection } from '@solana/web3.js'
import { PublicKey } from '@solana/web3.js'

/**
 * Resolve the exact USDC amount the user deposited on FOGO, for an
 * orphan deposit-delivery row where Wormholescan only shows the inbound
 * ONyc on FOGO.
 *
 * The lookup walks the relayer's Solana history:
 *   1. The row anchors on the Solana `lock_onyc` tx. Its logs include an
 *      `OnycLocked` event whose `flow` field (first Pubkey after the
 *      8-byte discriminator) is the per-flow PDA.
 *   2. The PDA is touched by exactly three relayer txs in lifecycle
 *      order: `claim_usdc` → `swap_usdc_to_onyc` → `lock_onyc` (which
 *      closes it). `getSignaturesForAddress(flow, before=lockSig)`
 *      enumerates the first two.
 *   3. The earliest of those (claim_usdc) emits `UsdcClaimed` whose
 *      trailing u64 is the canonical USDC the user deposited.
 *
 * Both events share the same wire layout — `disc(8) + flow(32) +
 * pubkey(32) + pubkey(32) + amount(u64 LE)` — so we decode the raw
 * `Program data:` lines by discriminator match. This bypasses Anchor's
 * `EventParser`, which silently drops events when the SDK's bundled IDL
 * doesn't register them with the coder.
 *
 * **Failure-mode contract** — critical for the persisted React Query
 * cache that wraps this function:
 *   - **Throws** on transient failures (RPC threw, tx pruned, meta
 *     stripped, OnycLocked missing in the lock tx, zero prior sigs).
 *     React Query treats throws as errors, which the persister filters
 *     out via `status === 'success'`, so transient failures retry on
 *     next reload instead of being cached as a permanent tombstone.
 *   - **Returns `null`** only when the chain ran end-to-end and none of
 *     the enumerated prior sigs contained a `UsdcClaimed` event. That
 *     is genuinely terminal — caching it stops us from re-walking the
 *     chain forever for a row whose origin truly can't be recovered.
 *
 * **Program-shape assumption** — `UsdcClaimed` is emitted by
 * `claim_usdc`, which is a *prior* PDA touch (we scan with
 * `before: lockOnycSig`, excluding the lock itself). If a future
 * program revision moves the emit to `lock_onyc`, this function will
 * silently return `null` for every row. The sha256 binary pin in
 * `tests/utils/withdraw-scaffolding.ts` is the tripwire for that
 * shape change.
 */
export interface DepositAmountSources {
  connection: Connection
}

/** `sha256("event:OnycLocked")[..8]` — pinned; the program emits this forever. */
const ONYC_LOCKED_DISC = Uint8Array.of(0xCC, 0xE5, 0x07, 0x91, 0x79, 0xBB, 0xC9, 0xD7)
/** `sha256("event:UsdcClaimed")[..8]`. */
const USDC_CLAIMED_DISC = Uint8Array.of(0xD5, 0x18, 0xFF, 0xCB, 0xA3, 0xA2, 0x9A, 0x89)
const PROGRAM_DATA_PREFIX = 'Program data: '
/** Wire layout: disc(8) + 3×Pubkey(32) + amount(u64) — strict so a field-add fails loud. */
const EVENT_PAYLOAD_LEN = 112
/**
 * Upper bound on prior-sig pagination. The PDA's lifecycle has exactly
 * two prior touches before `lock_onyc` (`claim_usdc`, `swap_usdc_to_onyc`),
 * so we expect 2. The cap protects against pathological RPC behavior
 * or future program changes that add intermediate touches.
 */
const MAX_PRIOR_SIG_SCAN = 100
const PRIOR_SIG_PAGE_SIZE = 25
/** Backoff base for 429 retries — quick first retry, exponential thereafter. */
const RETRY_BASE_MS = 400
const RETRY_MAX_ATTEMPTS = 4

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      const is429 = msg.includes('429') || /rate.?limit/i.test(msg)
      if (!is429 || attempt === RETRY_MAX_ATTEMPTS - 1) {
        throw err
      }
      const wait = RETRY_BASE_MS * 2 ** attempt + Math.random() * 100
      console.warn(`[deposit-usdc] 429 on ${label}, retrying in ${Math.round(wait)}ms (attempt ${attempt + 1})`)
      await new Promise(r => setTimeout(r, wait))
    }
  }
  throw lastErr
}

/**
 * Serialize recovery walks so the N independent React Query rows (one
 * per visible deposit) don't fire ~3 RPC calls each in parallel and
 * burst the public endpoint into 429s. Each call appends to a single
 * promise chain; the tail swallows errors so one failed walk can't
 * poison the chain, while the returned promise still rejects to its own
 * caller. Serializing only costs first-load latency — results are
 * cached + persisted, so warm loads do zero RPC.
 */
let walkTail: Promise<unknown> = Promise.resolve()

export function fetchDepositUsdcAmount(
  sources: DepositAmountSources,
  lockOnycSig: string,
): Promise<bigint | null> {
  const run = walkTail.then(() => walkDepositUsdcAmount(sources, lockOnycSig))
  walkTail = run.then(() => undefined, () => undefined)
  return run
}

async function walkDepositUsdcAmount(
  sources: DepositAmountSources,
  lockOnycSig: string,
): Promise<bigint | null> {
  const { connection } = sources
  console.info('[deposit-usdc] start', { lockOnycSig, rpc: connection.rpcEndpoint })

  const flowPk = await readFlowFromLockTx(connection, lockOnycSig)
  console.info('[deposit-usdc] step1 ok: flow PDA', { flow: flowPk.toBase58() })

  // Paginate the prior-sig walk until exhausted or capped. The PDA
  // is expected to carry 2 prior touches (`claim_usdc`,
  // `swap_usdc_to_onyc`), but capping at MAX_PRIOR_SIG_SCAN protects
  // against pathological RPC results without letting a false-terminal
  // `null` tombstone a recoverable row.
  const sigs: string[] = []
  let cursor: string = lockOnycSig
  while (sigs.length < MAX_PRIOR_SIG_SCAN) {
    const page = await withRetry(
      `getSignaturesForAddress(${flowPk.toBase58()}, before=${cursor})`,
      () => connection.getSignaturesForAddress(flowPk, {
        before: cursor,
        limit: PRIOR_SIG_PAGE_SIZE,
      }),
    )
    if (page.length === 0) {
      break
    }
    for (const s of page) {
      sigs.push(s.signature)
    }
    cursor = page[page.length - 1]!.signature
    if (page.length < PRIOR_SIG_PAGE_SIZE) {
      break
    }
  }
  console.info('[deposit-usdc] step2: flow sigs enumerated', { count: sigs.length, sigs })
  if (sigs.length === 0) {
    // The PDA proven-to-exist (we just parsed its event) has no prior sigs
    // visible — only plausible cause is ledger pruning. Transient, throw.
    throw new Error(`[deposit-usdc] flow PDA ${flowPk.toBase58()} has zero prior sigs (RPC likely pruned)`)
  }

  for (let i = sigs.length - 1; i >= 0; i--) {
    // Oldest-first: `UsdcClaimed` lives only on `claim_usdc` (oldest
    // prior sig), so reverse scan saves one `getTransaction` per row.
    const sig = sigs[i]!
    const amount = await readClaimedAmount(connection, sig)
    if (amount !== null) {
      console.info('[deposit-usdc] step3 ok: UsdcClaimed amount', { sig, amount: amount.toString() })
      return amount
    }
  }
  // Terminal: every candidate sig was readable and none carried the event.
  // Persisting this null stops endless re-walks for an unrecoverable row.
  console.warn('[deposit-usdc] terminal null: no UsdcClaimed among prior flow sigs', { sigs })
  return null
}

async function readFlowFromLockTx(connection: Connection, sig: string): Promise<PublicKey> {
  const logs = await fetchLogs(connection, sig)
  const first = iterEventPayloads(logs, ONYC_LOCKED_DISC).next()
  if (first.done) {
    throw new Error(`[deposit-usdc] no OnycLocked event in lock tx ${sig} (program changed or wrong sig)`)
  }
  return new PublicKey(first.value.slice(8, 40))
}

async function readClaimedAmount(connection: Connection, sig: string): Promise<bigint | null> {
  const logs = await fetchLogs(connection, sig)
  const first = iterEventPayloads(logs, USDC_CLAIMED_DISC).next()
  if (first.done) {
    return null
  }
  const payload = first.value
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
  return view.getBigUint64(payload.length - 8, true)
}

async function fetchLogs(connection: Connection, sig: string): Promise<string[]> {
  let tx
  try {
    tx = await withRetry(
      `getTransaction(${sig})`,
      () => connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 }),
    )
  } catch (err) {
    throw new Error(`[deposit-usdc] getTransaction(${sig}) threw: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (tx === null) {
    throw new Error(`[deposit-usdc] getTransaction(${sig}) returned null (RPC pruned or unconfirmed)`)
  }
  const logs = tx.meta?.logMessages
  if (!logs) {
    throw new Error(`[deposit-usdc] tx ${sig} has no log messages (meta stripped by RPC)`)
  }
  return logs
}

function* iterEventPayloads(logs: readonly string[], disc: Uint8Array): Generator<Uint8Array> {
  for (const line of logs) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) {
      continue
    }
    let bytes: Uint8Array
    try {
      const b64 = line.slice(PROGRAM_DATA_PREFIX.length).trim()
      const bin = atob(b64)
      bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
    } catch {
      continue
    }
    if (bytes.length < 8) {
      continue
    }
    let match = true
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== disc[i]) {
        match = false
        break
      }
    }
    if (!match) {
      continue
    }
    if (bytes.length !== EVENT_PAYLOAD_LEN) {
      console.warn('[deposit-usdc] event payload length drift — skipping', {
        expected: EVENT_PAYLOAD_LEN,
        got: bytes.length,
      })
      continue
    }
    yield bytes
  }
}
