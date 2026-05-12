'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const FOGO_NETWORK_NAME = process.env.NEXT_PUBLIC_FOGO_NETWORK ?? 'mainnet'
// FOGO RPC defaults to a first-party Fogo Labs endpoint per network — fine
// to default. Solana RPC is a third-party JPool endpoint that can rate-limit
// under load and isn't promised; in production we refuse to silently default
// to it so an explicit choice is recorded in the deployment env.
const FOGO_RPC_DEFAULT = process.env.NEXT_PUBLIC_FOGO_RPC_URL
  ?? (FOGO_NETWORK_NAME === 'testnet' ? 'https://testnet.fogo.io' : 'https://mainnet.fogo.io')

// FOGO RPC defaults to a first-party Fogo Labs endpoint per network — fine
// to default. Solana RPC is a third-party JPool endpoint that can rate-limit
// under load and isn't promised; we surface a build-time warning when the
// env var isn't set so operators don't accidentally ship the rate-limited
// fallback to production traffic. The fallback itself is safe enough to
// keep the build passing — see the matching note in `constants.ts` on
// `APP_DOMAIN` for why we don't hard-throw here.
const SOLANA_RPC_FALLBACK = 'https://rpc.jpool.one'
function resolveSolanaRpcDefault(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SOLANA_RPC_URL
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv
  }
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      `[fogo-onre] NEXT_PUBLIC_SOLANA_RPC_URL not set; falling back to ${SOLANA_RPC_FALLBACK}. `
      + `That endpoint is third-party and rate-limited — set this env var to a `
      + `Solana mainnet RPC you trust before serving production traffic.`,
    )
  }
  return SOLANA_RPC_FALLBACK
}
const SOLANA_RPC_DEFAULT = resolveSolanaRpcDefault()

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
