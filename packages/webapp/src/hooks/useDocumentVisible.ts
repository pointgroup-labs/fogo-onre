'use client'

import { useSyncExternalStore } from 'react'

/**
 * `true` when the document is visible (foreground tab). Lets polling
 * hooks pause RPC traffic when the user isn't looking — Solana public
 * RPCs rate-limit aggressively, and a backgrounded tab still draining
 * quota is the kind of thing that gets a deployment blocked.
 *
 * SSR-safe via `useSyncExternalStore`: the server snapshot is `true`, so
 * the initial client tree matches the server render.
 */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, visibilitySnapshot, () => true)
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

function visibilitySnapshot(): boolean {
  return document.visibilityState === 'visible'
}
