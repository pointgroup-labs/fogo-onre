'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const FOGO_NETWORK_NAME = process.env.NEXT_PUBLIC_FOGO_NETWORK ?? 'mainnet'
const FOGO_RPC_DEFAULT = process.env.NEXT_PUBLIC_FOGO_RPC_URL
  ?? (FOGO_NETWORK_NAME === 'testnet' ? 'https://testnet.fogo.io' : 'https://mainnet.fogo.io')
const SOLANA_RPC_DEFAULT = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://rpc.jpool.one'

export interface SettingsState {
  fogoRpcUrl: string | null
  solanaRpcUrl: string | null
  setFogoRpcUrl: (url: string | null) => void
  setSolanaRpcUrl: (url: string | null) => void
}

const STORAGE_KEY = 'fogo-onre.settings.v1'

/**
 * Empty/whitespace-only strings collapse to `null` so resolution falls
 * through to env / hardcoded defaults instead of pinning an empty value.
 */
function normalize(url: string | null): string | null {
  if (url === null) {
    return null
  }
  const trimmed = url.trim()
  return trimmed === '' ? null : trimmed
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    set => ({
      fogoRpcUrl: null,
      solanaRpcUrl: null,
      setFogoRpcUrl: url => set({ fogoRpcUrl: normalize(url) }),
      setSolanaRpcUrl: url => set({ solanaRpcUrl: normalize(url) }),
    }),
    {
      name: STORAGE_KEY,
      partialize: state => ({
        fogoRpcUrl: state.fogoRpcUrl,
        solanaRpcUrl: state.solanaRpcUrl,
      }),
    },
  ),
)

export interface ResolvedSettings {
  /** Effective FOGO RPC: user override → env → hardcoded mainnet/testnet. */
  fogoRpcUrl: string
  /** Effective Solana RPC: user override → env → JPool. */
  solanaRpcUrl: string
  /**
   * Env/hardcoded default — what the user gets when they pick "Default"
   * in the drawer. The drawer surfaces this in the preset label.
   */
  fogoRpcDefault: string
  /** Env/hardcoded default. */
  solanaRpcDefault: string
}

/**
 * Single source of truth for resolved settings. Components that need to
 * react to settings changes (re-bind a polling effect, rebuild a
 * Connection, etc.) read from this hook and key effects on the
 * primitives they care about.
 */
export function useSettings(): ResolvedSettings {
  const fogoOverride = useSettingsStore(s => s.fogoRpcUrl)
  const solanaOverride = useSettingsStore(s => s.solanaRpcUrl)
  return {
    fogoRpcUrl: fogoOverride ?? FOGO_RPC_DEFAULT,
    solanaRpcUrl: solanaOverride ?? SOLANA_RPC_DEFAULT,
    fogoRpcDefault: FOGO_RPC_DEFAULT,
    solanaRpcDefault: SOLANA_RPC_DEFAULT,
  }
}

/** Imperative read for non-React call sites (singletons, builders). */
export function getSettings(): ResolvedSettings {
  const s = useSettingsStore.getState()
  return {
    fogoRpcUrl: s.fogoRpcUrl ?? FOGO_RPC_DEFAULT,
    solanaRpcUrl: s.solanaRpcUrl ?? SOLANA_RPC_DEFAULT,
    fogoRpcDefault: FOGO_RPC_DEFAULT,
    solanaRpcDefault: SOLANA_RPC_DEFAULT,
  }
}
