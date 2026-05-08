/**
 * Insertion-ordered map with FIFO eviction at a configurable max size.
 *
 * Uses the fact that JavaScript `Map` preserves insertion order — the
 * first key returned by `keys()` is the oldest. Eviction is harmless for
 * any callsite where the underlying source is authoritative and the cache
 * is purely a latency optimization (the cranker's user-wallet cache is
 * the original use case: chain is the source of truth, eviction at most
 * causes one extra FOGO RPC the next time the same VAA is enumerated).
 *
 * Note: `set()` on an existing key updates the value but does not
 * reorder — the key keeps its original insertion position. This is
 * deliberate: callers want bounded memory, not LRU semantics. If true
 * LRU is ever needed, swap in a different impl behind the same shape.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super()
    if (max <= 0) {
      throw new Error(`BoundedMap max must be > 0, got ${max}`)
    }
  }

  override set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.max) {
      const oldest = this.keys().next().value
      if (oldest !== undefined) {
        this.delete(oldest)
      }
    }
    return super.set(key, value)
  }
}
