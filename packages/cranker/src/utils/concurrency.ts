/**
 * Bounded-concurrency worker pool. `concurrency` workers pick items off
 * a shared cursor; each worker exits when there are no more items or the
 * abort signal fires.
 *
 * `throwOnAbort` controls behavior when the signal fires mid-flight:
 *   - `true` (Flow scanner): rethrow as `runBounded aborted mid-flight`
 *     so the daemon's outer `Promise.race` against the shutdown deadline
 *     short-circuits and we don't get stuck in a partial scan.
 *   - `false` (bridge scanner): silently exit so the bridge leg's
 *     partial result merges cleanly with `Promise.allSettled` alongside
 *     the Flow leg — neither leg should drag the other down on abort.
 *
 * Workers are contractually no-throw (advance fns / per-VAA workers
 * map errors into result types). A throw here is a bug; we surface via
 * the optional `onWorkerThrow` hook rather than swallowing.
 */
export async function runBounded<T>(
  items: T[],
  concurrency: number,
  signal: AbortSignal,
  worker: (item: T, index: number) => Promise<void>,
  opts: {
    throwOnAbort?: boolean
    onWorkerThrow?: (err: unknown) => void
  } = {},
): Promise<void> {
  let i = 0
  let aborted = false
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < items.length) {
      if (signal.aborted) {
        aborted = true
        return
      }
      const idx = i++
      await worker(items[idx], idx).catch((err) => {
        opts.onWorkerThrow?.(err)
      })
    }
  })
  await Promise.all(workers)
  if (aborted && opts.throwOnAbort) {
    throw new Error('runBounded aborted mid-flight')
  }
}
