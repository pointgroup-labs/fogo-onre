import type { WatermarkStore } from './watermarks'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { restoreWatermarks, snapshotWatermarks } from './watermarks'

/**
 * On-disk shape. Keep flat — adding fields later is fine, but rev the
 * `version` so a forward-compat reader can ignore unknown shapes
 * gracefully. Bigints serialize as decimal strings.
 */
export type CheckpointFile = {
  version: 1
  watermarks: Record<string, string>
  updatedAt: string
}

/**
 * Best-effort load: corruption / missing file is *not* fatal because
 * on-chain idempotency means the worst case is a one-time backfill.
 * Return `undefined` and let the caller start with an empty store.
 */
export function loadCheckpoint(path: string): CheckpointFile | undefined {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as CheckpointFile
    if (parsed.version !== 1 || typeof parsed.watermarks !== 'object') {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Last-written watermark-payload hash per path. Lets the periodic flush
 * skip the disk write when nothing changed since the last save —
 * meaningful at the daemon's 30s flush cadence, where most ticks see no
 * watermark advance (no new VAAs from any tracked emitter). The hash
 * covers only the watermark payload, not `updatedAt`, so the skip is
 * driven by *content* drift, not wall-clock churn.
 */
const lastWrittenHash = new Map<string, string>()

function hashWatermarks(snapshot: Record<string, string>): string {
  // Object.keys ordering is insertion-order in V8; sort for stability so
  // a Map populated in different orders still produces the same hash.
  const keys = Object.keys(snapshot).sort()
  const h = createHash('sha256')
  for (const k of keys) {
    h.update(k)
    h.update('\0')
    h.update(snapshot[k])
    h.update('\0')
  }
  return h.digest('hex')
}

/**
 * Atomic write: temp file + `rename`. POSIX `rename` is atomic on the
 * same filesystem, so a crash mid-flush leaves either the old file
 * intact or the new one fully present — never a half-written state.
 *
 * Returns `true` if a write actually happened, `false` if the payload
 * was unchanged since the last save and the disk I/O was skipped. The
 * skip is a pure optimization — callers should not rely on `true` for
 * correctness, only for telemetry / metrics.
 */
export function saveCheckpoint(path: string, store: WatermarkStore): boolean {
  const watermarks = snapshotWatermarks(store)
  const hash = hashWatermarks(watermarks)
  if (lastWrittenHash.get(path) === hash) {
    return false
  }
  mkdirSync(dirname(path), { recursive: true })
  const file: CheckpointFile = {
    version: 1,
    watermarks,
    updatedAt: new Date().toISOString(),
  }
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2))
  renameSync(tmp, path)
  lastWrittenHash.set(path, hash)
  return true
}

export function watermarksFromCheckpoint(cp: CheckpointFile | undefined): WatermarkStore {
  if (!cp) {
    return new Map()
  }
  return restoreWatermarks(cp.watermarks)
}
