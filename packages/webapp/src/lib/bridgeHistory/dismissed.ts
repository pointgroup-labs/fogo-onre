'use client'

/**
 * Client-side "I see my funds, stop showing me Pending" override for
 * bridge-history rows. Used when the Wormholescan oracle cannot
 * report `delivered` for a tx whose VAA was produced out-of-band —
 * e.g. legacy pre-fix `send_usdc_to_user` rows whose VAA was emitted
 * by a separate `release_wormhole_outbound` recovery tx, so
 * `/operations?txHash=<source>` finds no `targetChain.transaction`.
 *
 * Persistence: a single localStorage key (`fogo-onre.dismissed-bridges.v1`)
 * holding a JSON array of source signatures. Deliberately decoupled
 * from the React Query persister so clearing one doesn't clear the
 * other and the schema can evolve independently.
 *
 * Safety: dismissal is per-device and purely cosmetic. It cannot move
 * funds, cannot affect cranker classification, cannot affect on-chain
 * state. If the user dismisses a row by mistake they can clear
 * localStorage to recover; the canonical on-chain history is intact.
 */

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'fogo-onre.dismissed-bridges.v1'
const CHANGE_EVENT = 'fogo-onre.dismissed-bridges:change'

function readSet(): Set<string> {
  if (typeof window === 'undefined') {
    return new Set()
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return new Set()
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return new Set()
    }
    return new Set(parsed.filter((v): v is string => typeof v === 'string'))
  } catch {
    // Corrupt storage — start fresh rather than crashing the history UI.
    return new Set()
  }
}

function writeSet(set: Set<string>): void {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  // Notify subscribers in this tab. localStorage's native `storage`
  // event only fires for cross-tab changes, so we use a custom event
  // for same-tab listeners.
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function dismissBridge(signature: string): void {
  const set = readSet()
  if (set.has(signature)) {
    return
  }
  set.add(signature)
  writeSet(set)
}

export function undismissBridge(signature: string): void {
  const set = readSet()
  if (!set.delete(signature)) {
    return
  }
  writeSet(set)
}

/**
 * Reactive accessor. Re-renders the component on any change to the
 * dismissed set (same tab via custom event; cross-tab via native
 * `storage` event). Returns a stable Set instance per snapshot so
 * `decorateAction` deps in `useBridgeHistory` invalidate correctly.
 */
export function useDismissedBridges(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

// Cached snapshot — `useSyncExternalStore` requires referential
// stability across calls until the underlying data changes.
let cachedSnapshot: Set<string> = new Set()
let cachedSerialized: string | null = null
function getSnapshot(): Set<string> {
  const fresh = readSet()
  const serialized = JSON.stringify([...fresh].sort())
  if (serialized !== cachedSerialized) {
    cachedSerialized = serialized
    cachedSnapshot = fresh
  }
  return cachedSnapshot
}

function getServerSnapshot(): Set<string> {
  return cachedSnapshot
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {}
  }
  const handler = (e: StorageEvent | Event): void => {
    if (e instanceof StorageEvent && e.key !== null && e.key !== STORAGE_KEY) {
      return
    }
    onChange()
  }
  window.addEventListener('storage', handler)
  window.addEventListener(CHANGE_EVENT, handler)
  return () => {
    window.removeEventListener('storage', handler)
    window.removeEventListener(CHANGE_EVENT, handler)
  }
}
