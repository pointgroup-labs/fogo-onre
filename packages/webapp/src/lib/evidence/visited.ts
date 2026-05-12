'use client'

/**
 * Per-device tracking of which on-chain signatures the user has
 * personally clicked through to a block explorer for. Powers the
 * "verified by you" affordance on the tx-detail Evidence panel.
 *
 * Why: Generation-Effect leverage — users remember and trust what they
 * personally verified, not what a UI told them was verified. Clicking
 * an explorer link is a deliberate act; reflecting it back as a small
 * persistent ring on the receipt converts the panel from "the system
 * says it's fine" to "I checked, and it's fine".
 *
 * Persistence: a single localStorage key
 * (`fogo-onre.visited-signatures.v1`) holding a JSON array of
 * signatures. Mirrors the shape of `dismissed-bridges.v1` so the two
 * stay structurally cousins (same SSR safety, same custom-event
 * cross-tab signaling, same corruption recovery).
 *
 * Safety / privacy: tracked locally only, never sent off-device.
 * Distinct localStorage key from `dismissed-bridges` so clearing one
 * doesn't clobber the other and the schemas can evolve
 * independently.  If the user switches wallets, they get a clean
 * verification slate naturally — signatures don't collide across
 * wallets, and the set won't surface visited rings for a different
 * user's bridges anyway.
 */

import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'fogo-onre.visited-signatures.v1'
const CHANGE_EVENT = 'fogo-onre.visited-signatures:change'

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
    return new Set()
  }
}

function writeSet(set: Set<string>): void {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function markSignatureVisited(signature: string): void {
  const set = readSet()
  if (set.has(signature)) {
    return
  }
  set.add(signature)
  writeSet(set)
}

export function useVisitedSignatures(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

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
