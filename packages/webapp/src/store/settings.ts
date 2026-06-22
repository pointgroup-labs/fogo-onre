'use client'

import { DEFAULT_SLIPPAGE_TOLERANCE_BPS } from '@fogo-onre/sdk'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

const FOGO_NETWORK_NAME = process.env.NEXT_PUBLIC_FOGO_NETWORK ?? 'mainnet'
// FOGO RPC is a first-party Fogo Labs endpoint — safe to default.
const FOGO_RPC_DEFAULT = process.env.NEXT_PUBLIC_FOGO_RPC_URL
  ?? (FOGO_NETWORK_NAME === 'testnet' ? 'https://testnet.fogo.io' : 'https://mainnet.fogo.io')

// Solana RPC fallback is a third-party JPool endpoint that can rate-limit;
// warn at build time so operators don't ship it to production unknowingly.
// We don't hard-throw (see `APP_DOMAIN` in `constants.ts` for why).
const SOLANA_RPC_FALLBACK = 'https://rpc.jpool.one'
function resolveSolanaRpcDefault(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SOLANA_RPC_URL
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn(
      `[fogo-onre] NEXT_PUBLIC_SOLANA_RPC_URL not set; falling back to ${SOLANA_RPC_FALLBACK}. `
      + `That endpoint is third-party and rate-limited — set this env var to a `
      + `Solana mainnet RPC you trust before serving production traffic.`,
    )
  }
  return SOLANA_RPC_FALLBACK
}
const SOLANA_RPC_DEFAULT = resolveSolanaRpcDefault()

/**
 * UI bound on the user-set swap-floor tolerance (50%). A too-tight value
 * just reverts on-chain (fail-safe); this cap stops fat-finger 100%+ entries.
 */
export const MAX_SLIPPAGE_TOLERANCE_BPS = 5_000

export interface SettingsState {
  fogoRpcUrl: string | null
  solanaRpcUrl: string | null
  /** Swap-floor tolerance in bps; `null` falls through to the SDK default. */
  slippageBps: number | null
  setFogoRpcUrl: (url: string | null) => void
  setSolanaRpcUrl: (url: string | null) => void
  setSlippageBps: (bps: number | null) => void
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

/** Clamp to `[0, MAX_SLIPPAGE_TOLERANCE_BPS]`; non-finite/empty → `null` (default). */
function normalizeSlippage(bps: number | null): number | null {
  if (bps === null || !Number.isFinite(bps)) {
    return null
  }
  const rounded = Math.round(bps)
  if (rounded < 0) {
    return 0
  }
  return rounded > MAX_SLIPPAGE_TOLERANCE_BPS ? MAX_SLIPPAGE_TOLERANCE_BPS : rounded
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    set => ({
      fogoRpcUrl: null,
      solanaRpcUrl: null,
      slippageBps: null,
      setFogoRpcUrl: url => set({ fogoRpcUrl: normalize(url) }),
      setSolanaRpcUrl: url => set({ solanaRpcUrl: normalize(url) }),
      setSlippageBps: bps => set({ slippageBps: normalizeSlippage(bps) }),
    }),
    {
      name: STORAGE_KEY,
      partialize: state => ({
        fogoRpcUrl: state.fogoRpcUrl,
        solanaRpcUrl: state.solanaRpcUrl,
        slippageBps: state.slippageBps,
      }),
    },
  ),
)

export interface ResolvedSettings {
  /** Effective FOGO RPC: user override → env → hardcoded mainnet/testnet. */
  fogoRpcUrl: string
  /** Effective Solana RPC: user override → env → JPool. */
  solanaRpcUrl: string
  /** Effective swap-floor tolerance: user override → SDK default. */
  slippageBps: number
  /**
   * Env/hardcoded default — what the user gets when they pick "Default"
   * in the drawer. The drawer surfaces this in the preset label.
   */
  fogoRpcDefault: string
  /** Env/hardcoded default. */
  solanaRpcDefault: string
  /** SDK default slippage — the drawer surfaces it as the placeholder. */
  slippageDefault: number
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
  const slippageOverride = useSettingsStore(s => s.slippageBps)
  return {
    fogoRpcUrl: fogoOverride ?? FOGO_RPC_DEFAULT,
    solanaRpcUrl: solanaOverride ?? SOLANA_RPC_DEFAULT,
    slippageBps: slippageOverride ?? DEFAULT_SLIPPAGE_TOLERANCE_BPS,
    fogoRpcDefault: FOGO_RPC_DEFAULT,
    solanaRpcDefault: SOLANA_RPC_DEFAULT,
    slippageDefault: DEFAULT_SLIPPAGE_TOLERANCE_BPS,
  }
}

/** Imperative read for non-React call sites (singletons, builders). */
export function getSettings(): ResolvedSettings {
  const s = useSettingsStore.getState()
  return {
    fogoRpcUrl: s.fogoRpcUrl ?? FOGO_RPC_DEFAULT,
    solanaRpcUrl: s.solanaRpcUrl ?? SOLANA_RPC_DEFAULT,
    slippageBps: s.slippageBps ?? DEFAULT_SLIPPAGE_TOLERANCE_BPS,
    fogoRpcDefault: FOGO_RPC_DEFAULT,
    solanaRpcDefault: SOLANA_RPC_DEFAULT,
    slippageDefault: DEFAULT_SLIPPAGE_TOLERANCE_BPS,
  }
}
