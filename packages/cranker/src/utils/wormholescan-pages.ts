import type { WormholescanClient, WormholescanVaa } from '@fogo-onre/sdk'
import type { WatermarkStore } from '../state/watermarks'
import { isPageBelowFloor, pagingFloor } from '../state/watermarks'

/**
 * Async-paged Wormholescan VAA harvest. Yields one page at a time so the
 * caller can do per-page work (e.g. fan out per-VAA RPCs in parallel)
 * without owning the paging+floor mechanics.
 *
 * Stops when:
 *   - `maxPages` reached
 *   - `abortSignal` fired
 *   - empty page (caught up to head)
 *   - `isPageBelowFloor(floor, items)` — every entry at-or-below the
 *     watermark, so newer-first ordering proves no later page can have
 *     anything new. The `BACKFILL_COUNT` slack baked into `pagingFloor`
 *     absorbs out-of-order delivery near the head.
 *
 * **Watermark recording is the consumer's responsibility.** The harvest
 * uses `watermarks` only to compute the *floor* (where to stop paging);
 * advancing the watermark happens in the caller, *after* the per-VAA
 * processing has succeeded. This prevents a transient per-VAA fetch
 * failure from advancing the floor past a VAA that hasn't actually been
 * processed (which would silently drop it from the next scan's window).
 *
 * Wormholescan fetch failures are surfaced via `onPageError` so the
 * caller chooses log severity / metrics; the harvest yields an empty
 * iteration in that case (no recordSeen, no floor-stop) and stops since
 * `items.length === 0`.
 */
export async function* harvestVaaPages(opts: {
  ws: WormholescanClient
  chainId: number
  emitterHex: string
  pageSize: number
  maxPages: number
  /** Floor lookup only; see fn doc — caller advances watermarks. */
  watermarks?: WatermarkStore
  abortSignal: AbortSignal
  onPageError?: (page: number, err: unknown) => void
  onPageFetched?: (page: number, count: number, floor: bigint) => void
}): AsyncGenerator<WormholescanVaa[], void, void> {
  const floor = opts.watermarks
    ? pagingFloor(opts.watermarks, opts.chainId, opts.emitterHex)
    : 0n
  for (let page = 0; page < opts.maxPages; page++) {
    if (opts.abortSignal.aborted) {
      return
    }
    const items = await opts.ws
      .listVaasByEmitter(opts.chainId, opts.emitterHex, { pageSize: opts.pageSize, page })
      .catch((err): WormholescanVaa[] => {
        opts.onPageError?.(page, err)
        return []
      })
    opts.onPageFetched?.(page, items.length, floor)
    if (items.length === 0) {
      return
    }
    yield items
    if (isPageBelowFloor(floor, items)) {
      return
    }
  }
}
