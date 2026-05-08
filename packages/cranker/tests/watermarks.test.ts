import type { WatermarkStore } from '../src/state/watermarks'
import { describe, expect, it } from 'vitest'
import {
  BACKFILL_COUNT,
  isPageBelowFloor,
  pagingFloor,
  recordSeen,
  restoreWatermarks,
  snapshotWatermarks,
  watermarkKey,
} from '../src/state/watermarks'

const E = 'aa'.repeat(32)
const CHAIN = 1

describe('pagingFloor', () => {
  it('returns 0 when no watermark is set (first sighting → page until empty)', () => {
    const store: WatermarkStore = new Map()
    expect(pagingFloor(store, CHAIN, E)).toBe(0n)
  })

  it('returns watermark - BACKFILL_COUNT when above the slack', () => {
    const store: WatermarkStore = new Map([[watermarkKey(CHAIN, E), 1000n]])
    expect(pagingFloor(store, CHAIN, E)).toBe(1000n - BACKFILL_COUNT)
  })

  it('clamps to 0 when watermark is below the slack', () => {
    const store: WatermarkStore = new Map([[watermarkKey(CHAIN, E), 3n]])
    expect(pagingFloor(store, CHAIN, E)).toBe(0n)
  })

  it('keeps floors per (chain, emitter) independent', () => {
    // Same emitter hex, different source chains must not cross-contaminate
    // (e.g. SOLANA_ONYC_EMITTER === FOGO_ONYC_EMITTER under default config).
    const store: WatermarkStore = new Map([
      [watermarkKey(1, E), 100n],
      [watermarkKey(2, E), 0n],
    ])
    expect(pagingFloor(store, 1, E)).toBe(100n - BACKFILL_COUNT)
    expect(pagingFloor(store, 2, E)).toBe(0n)
    expect(pagingFloor(store, 3, E)).toBe(0n) // never seen
  })
})

describe('isPageBelowFloor', () => {
  it('treats empty page as "stop"', () => {
    expect(isPageBelowFloor(100n, [])).toBe(true)
  })

  it('returns false when floor is 0 (first sighting)', () => {
    expect(isPageBelowFloor(0n, [{ sequence: 1n }])).toBe(false)
  })

  it('returns true when every entry is at or below the floor', () => {
    expect(isPageBelowFloor(100n, [{ sequence: 50n }, { sequence: 100n }])).toBe(true)
  })

  it('returns false when any entry is above the floor', () => {
    expect(isPageBelowFloor(100n, [{ sequence: 99n }, { sequence: 101n }])).toBe(false)
  })
})

describe('recordSeen', () => {
  it('advances the watermark monotonically', () => {
    const store: WatermarkStore = new Map()
    recordSeen(store, CHAIN, E, 5n)
    recordSeen(store, CHAIN, E, 10n)
    recordSeen(store, CHAIN, E, 7n) // out-of-order: must not regress
    expect(store.get(watermarkKey(CHAIN, E))).toBe(10n)
  })

  it('keeps watermarks per emitter independent', () => {
    const store: WatermarkStore = new Map()
    const A = '11'.repeat(32)
    const B = '22'.repeat(32)
    recordSeen(store, CHAIN, A, 1n)
    recordSeen(store, CHAIN, B, 99n)
    expect(store.get(watermarkKey(CHAIN, A))).toBe(1n)
    expect(store.get(watermarkKey(CHAIN, B))).toBe(99n)
  })

  it('keeps watermarks per (chain, emitter) independent', () => {
    const store: WatermarkStore = new Map()
    recordSeen(store, 1, E, 50n)
    recordSeen(store, 2, E, 999n)
    expect(store.get(watermarkKey(1, E))).toBe(50n)
    expect(store.get(watermarkKey(2, E))).toBe(999n)
  })
})

describe('snapshot/restore round-trip', () => {
  it('preserves bigint values via decimal strings', () => {
    const k1 = watermarkKey(CHAIN, E)
    const k2 = watermarkKey(CHAIN, 'bb'.repeat(32))
    const original: WatermarkStore = new Map([
      [k1, 12345678901234567890n],
      [k2, 1n],
    ])
    const snap = snapshotWatermarks(original)
    expect(snap[k1]).toBe('12345678901234567890')
    const restored = restoreWatermarks(snap)
    expect(restored.get(k1)).toBe(12345678901234567890n)
    expect(restored.get(k2)).toBe(1n)
  })

  it('skips corrupt entries silently (treats as first sighting)', () => {
    const k = watermarkKey(CHAIN, E)
    const restored = restoreWatermarks({ [k]: 'not-a-number' })
    expect(restored.has(k)).toBe(false)
  })

  it('drops legacy un-prefixed keys (forces backfill via first-sighting)', () => {
    // Pre-composite-key snapshots used the raw emitter hex as the key.
    // Chain id is unrecoverable, so the only safe move is to drop and
    // re-backfill on next scan.
    const restored = restoreWatermarks({ [E]: '42' })
    expect(restored.size).toBe(0)
  })
})
