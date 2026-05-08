import { describe, expect, it } from 'vitest'
import { BoundedMap } from '../src/utils/bounded-map'

describe('bounded-map', () => {
  it('throws on non-positive max', () => {
    expect(() => new BoundedMap(0)).toThrow(/max must be > 0/)
    expect(() => new BoundedMap(-1)).toThrow(/max must be > 0/)
  })

  it('behaves like a Map below the bound', () => {
    const m = new BoundedMap<string, number>(3)
    m.set('a', 1).set('b', 2)
    expect(m.size).toBe(2)
    expect(m.get('a')).toBe(1)
    expect(m.get('b')).toBe(2)
  })

  it('evicts oldest insertion when bound is exceeded', () => {
    const m = new BoundedMap<string, number>(3)
    m.set('a', 1).set('b', 2).set('c', 3)
    expect(m.size).toBe(3)
    m.set('d', 4) // evicts 'a'
    expect(m.size).toBe(3)
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(true)
    expect(m.has('c')).toBe(true)
    expect(m.has('d')).toBe(true)
  })

  it('updating an existing key does not evict and does not reorder', () => {
    const m = new BoundedMap<string, number>(3)
    m.set('a', 1).set('b', 2).set('c', 3)
    m.set('a', 99) // update — no eviction
    expect(m.size).toBe(3)
    expect(m.get('a')).toBe(99)
    // Adding a fourth key should still evict 'a' (oldest insertion),
    // not 'b' — update did not bump 'a' to the back.
    m.set('d', 4)
    expect(m.has('a')).toBe(false)
    expect(m.has('b')).toBe(true)
  })

  it('repeated inserts past the bound keep size stable', () => {
    const m = new BoundedMap<number, number>(5)
    for (let i = 0; i < 1000; i++) {
      m.set(i, i * 2)
    }
    expect(m.size).toBe(5)
    // Last 5 insertions survive.
    expect(Array.from(m.keys())).toEqual([995, 996, 997, 998, 999])
  })

  it('is assignable to Map (subclass relationship)', () => {
    const m: Map<string, number> = new BoundedMap<string, number>(2)
    m.set('a', 1)
    expect(m.get('a')).toBe(1)
  })
})
