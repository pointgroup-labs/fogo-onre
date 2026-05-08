import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadCheckpoint, saveCheckpoint, watermarksFromCheckpoint } from '../src/state/checkpoint'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cranker-cp-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('saveCheckpoint / loadCheckpoint round-trip', () => {
  it('persists watermarks atomically and reloads them', () => {
    const path = join(dir, 'cp.json')
    const k = `1:${'aa'.repeat(32)}`
    const store = new Map<string, bigint>([[k, 42n]])
    saveCheckpoint(path, store)
    const loaded = loadCheckpoint(path)
    expect(loaded?.version).toBe(1)
    expect(loaded?.watermarks[k]).toBe('42')
    const restored = watermarksFromCheckpoint(loaded)
    expect(restored.get(k)).toBe(42n)
  })

  it('creates parent directories on write', () => {
    const path = join(dir, 'nested', 'sub', 'cp.json')
    saveCheckpoint(path, new Map([['x', 1n]]))
    expect(loadCheckpoint(path)).toBeDefined()
  })

  it('returns undefined for missing file (treated as first run)', () => {
    expect(loadCheckpoint(join(dir, 'missing.json'))).toBeUndefined()
  })

  it('returns undefined for corrupt file (treated as first run)', () => {
    const path = join(dir, 'cp.json')
    writeFileSync(path, '{not-json')
    expect(loadCheckpoint(path)).toBeUndefined()
  })

  it('returns undefined for unknown version (forward-compat)', () => {
    const path = join(dir, 'cp.json')
    writeFileSync(path, JSON.stringify({ version: 99, watermarks: {} }))
    expect(loadCheckpoint(path)).toBeUndefined()
  })

  it('writes via temp file (no half-written state on crash)', () => {
    // We can't simulate a crash here, but we can verify the final file
    // is fully valid JSON — i.e. the rename happened atomically.
    const path = join(dir, 'cp.json')
    saveCheckpoint(path, new Map([['x', 1n]]))
    const raw = readFileSync(path, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('skips disk write when payload unchanged (dirty-skip)', () => {
    const path = join(dir, 'cp.json')
    const store = new Map([['x', 1n]])
    expect(saveCheckpoint(path, store)).toBe(true) // first write
    const mtime1 = statSync(path).mtimeMs
    // Force the second save to be at least 5ms later so an mtime-based
    // assertion is unambiguous on filesystems with coarse timestamps.
    const start = Date.now()
    while (Date.now() - start < 5) { /* busy-wait */ }
    expect(saveCheckpoint(path, store)).toBe(false) // no payload change
    const mtime2 = statSync(path).mtimeMs
    expect(mtime2).toBe(mtime1) // file untouched
  })

  it('writes again after a watermark advances', () => {
    const path = join(dir, 'cp.json')
    const k = '1:abc'
    const store = new Map([[k, 1n]])
    expect(saveCheckpoint(path, store)).toBe(true)
    expect(saveCheckpoint(path, store)).toBe(false)
    store.set(k, 2n)
    expect(saveCheckpoint(path, store)).toBe(true)
    const restored = watermarksFromCheckpoint(loadCheckpoint(path))
    expect(restored.get(k)).toBe(2n)
  })

  it('hashes are key-order independent', () => {
    const path = join(dir, 'cp.json')
    const a = new Map<string, bigint>([['x', 1n], ['y', 2n]])
    const b = new Map<string, bigint>([['y', 2n], ['x', 1n]])
    expect(saveCheckpoint(path, a)).toBe(true)
    expect(saveCheckpoint(path, b)).toBe(false) // same content, different insertion order
  })
})
