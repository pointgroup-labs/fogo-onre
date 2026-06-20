/**
 * Per-(chain, emitter) "highest sequence seen" memo bounding Wormholescan
 * paging: newest-first ordering ends paging once a page sits entirely at-or-
 * below `watermark - BACKFILL_COUNT` (slack absorbs out-of-order VAAs). Keys
 * are `${chainId}:${emitterHex}` — emitter alone cross-contaminates floors when
 * two source chains share one (`SOLANA_ONYC_EMITTER_HEX === FOGO_ONYC_*`).
 */
export type WatermarkStore = Map<string, bigint>

export const BACKFILL_COUNT = 5n

/**
 * Composite key. Exposed so callers (tests, checkpoint migration) can
 * build keys without a separate helper.
 */
export function watermarkKey(chainId: number, emitter: string): string {
  return `${chainId}:${emitter}`
}

/**
 * Floor below which we trust we've already enumerated. Caller stops
 * paging when an entire page is at-or-below this. Returns 0n on first
 * sighting — caller pages until empty.
 */
export function pagingFloor(store: WatermarkStore, chainId: number, emitter: string): bigint {
  const wm = store.get(watermarkKey(chainId, emitter)) ?? 0n
  if (wm === 0n) {
    return 0n
  }
  return wm > BACKFILL_COUNT ? wm - BACKFILL_COUNT : 0n
}

/**
 * True if the entire page is at-or-below the floor — i.e. nothing new
 * to discover by paging further. With newest-first ordering this is
 * the safe stop condition. An empty page is also a stop (nothing left).
 */
export function isPageBelowFloor(
  floor: bigint,
  page: { sequence: bigint }[],
): boolean {
  if (page.length === 0) {
    return true
  }
  if (floor === 0n) {
    return false
  }
  for (const v of page) {
    if (v.sequence > floor) {
      return false
    }
  }
  return true
}

/**
 * Monotonic max update: the watermark only advances. Used by the
 * consumer (enumerator / bridge scanner) after each VAA is *processed*
 * — not blindly inside `harvestVaaPages`, so a transient per-VAA
 * fetch failure leaves the watermark untouched and the VAA stays in
 * the next scan's paging window.
 */
export function recordSeen(
  store: WatermarkStore,
  chainId: number,
  emitter: string,
  seq: bigint,
): void {
  const k = watermarkKey(chainId, emitter)
  const cur = store.get(k) ?? 0n
  if (seq > cur) {
    store.set(k, seq)
  }
}

/** Snapshot for persistence. Bigints serialize as decimal strings. */
export function snapshotWatermarks(store: WatermarkStore): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of store) {
    out[k] = v.toString()
  }
  return out
}

/**
 * Restore from a JSON snapshot. Forward-compat: any pre-composite-key
 * entries (no `chainId:` prefix) are dropped silently — equivalent to
 * a first-sighting for those emitters, which triggers a one-time
 * full backfill. Same on a corrupt bigint string.
 */
export function restoreWatermarks(snapshot: Record<string, string>): WatermarkStore {
  const out: WatermarkStore = new Map()
  for (const [k, v] of Object.entries(snapshot)) {
    if (!k.includes(':')) {
      // Legacy un-prefixed key — chain id unrecoverable; drop and backfill.
      continue
    }
    try {
      out.set(k, BigInt(v))
    } catch {
      // Corrupt bigint — drop and backfill.
    }
  }
  return out
}
