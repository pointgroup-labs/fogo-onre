'use client'

import { ChevronDown, Settings } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { MAX_SLIPPAGE_TOLERANCE_BPS, useSettings, useSettingsStore } from '@/store/settings'

interface RpcPreset {
  label: string
  url: string
}

const FOGO_PRESETS: RpcPreset[] = [
  { label: 'Mainnet — mainnet.fogo.io', url: 'https://mainnet.fogo.io' },
  { label: 'Testnet — testnet.fogo.io', url: 'https://testnet.fogo.io' },
]

const SOLANA_PRESETS: RpcPreset[] = [
  { label: 'JPool — rpc.jpool.one', url: 'https://rpc.jpool.one' },
  { label: 'Solana Mainnet — api.mainnet-beta.solana.com', url: 'https://api.mainnet-beta.solana.com' },
]

/**
 * Right-side settings sheet. Subscribes to `useSettingsStore` for live
 * values; every change persists immediately via the store's `persist`
 * middleware, and downstream consumers (Connection singletons, polling
 * hooks, FogoSessionProvider) re-bind via the unified `useSettings()`
 * hook — no page reload required. Focus trap, scroll lock, and Esc are
 * provided by the underlying Radix Dialog primitive.
 */
export default function SettingsSheet() {
  const fogoRpcOverride = useSettingsStore(s => s.fogoRpcUrl)
  const solanaRpcOverride = useSettingsStore(s => s.solanaRpcUrl)
  const slippageOverride = useSettingsStore(s => s.slippageBps)
  const setFogoRpcUrl = useSettingsStore(s => s.setFogoRpcUrl)
  const setSolanaRpcUrl = useSettingsStore(s => s.setSolanaRpcUrl)
  const setSlippageBps = useSettingsStore(s => s.setSlippageBps)
  const { fogoRpcUrl, solanaRpcUrl, slippageDefault } = useSettings()

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Open settings" title="Settings">
          <Settings className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent className="flex flex-col gap-6">
        <SheetHeader>
          <SheetTitle>Settings</SheetTitle>
          <SheetDescription>Override the RPC endpoints and swap tolerance. Changes apply immediately.</SheetDescription>
        </SheetHeader>
        <section className="flex flex-col gap-4 px-4 pb-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Network</h3>
          <RpcSelect
            label="FOGO RPC"
            presets={FOGO_PRESETS}
            effective={fogoRpcUrl}
            value={fogoRpcOverride ?? ''}
            onChange={setFogoRpcUrl}
          />
          <RpcSelect
            label="Solana RPC"
            presets={SOLANA_PRESETS}
            effective={solanaRpcUrl}
            value={solanaRpcOverride ?? ''}
            onChange={setSolanaRpcUrl}
          />
        </section>
        <section className="flex flex-col gap-4 px-4 pb-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Swap tolerance</h3>
          <SlippageInput
            value={slippageOverride}
            defaultBps={slippageDefault}
            onChange={setSlippageBps}
          />
        </section>
      </SheetContent>
    </Sheet>
  )
}

const CUSTOM_SENTINEL = '__custom__'
const CUSTOM_DEBOUNCE_MS = 400

const MAX_SLIPPAGE_PCT = MAX_SLIPPAGE_TOLERANCE_BPS / 100

function bpsToPctStr(bps: number): string {
  return (bps / 100).toString()
}

interface SlippageInputProps {
  /** Persisted override in bps (`null` = use default). */
  value: number | null
  /** SDK default in bps, shown as the placeholder. */
  defaultBps: number
  onChange: (bps: number | null) => void
}

/**
 * Swap-tolerance control. The user types a percentage; we persist bps.
 * Empty input clears the override (falls back to the default). The floor
 * is signed into the bridge tx, so a too-tight value just reverts on-chain.
 */
function SlippageInput({ value, defaultBps, onChange }: SlippageInputProps) {
  const [draft, setDraft] = useState<string>(() => (value === null ? '' : bpsToPctStr(value)))
  // Resync the draft when the committed `value` changes — React's documented
  // "adjust state during render" pattern (no post-render effect / stale flash).
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(value === null ? '' : bpsToPctStr(value))
  }

  const commit = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === '') {
      onChange(null)
      return
    }
    const pct = Number(trimmed)
    if (!Number.isFinite(pct)) {
      onChange(null)
      return
    }
    onChange(Math.round(pct * 100))
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-foreground" htmlFor="slippage-tolerance">
        Max slippage (%)
      </label>
      <Input
        id="slippage-tolerance"
        type="number"
        inputMode="decimal"
        min={0}
        max={MAX_SLIPPAGE_PCT}
        step={0.1}
        value={draft}
        placeholder={bpsToPctStr(defaultBps)}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
      />
      <p className="text-xs text-muted-foreground">
        Floor for the on-chain swap. Too tight reverts and retries; leave empty for
        {' '}
        {bpsToPctStr(defaultBps)}
        % default.
      </p>
    </div>
  )
}

interface RpcSelectProps {
  label: string
  presets: RpcPreset[]
  /** Resolved URL actually in use right now (for default-preset display). */
  effective: string
  /** Persisted user override ('' = no override). */
  value: string
  onChange: (v: string | null) => void
}

/**
 * RPC dropdown: presets + "Custom" sentinel that reveals an input.
 *
 * `customMode` is explicit user intent, *not* derived from `value`.
 * That distinction matters because in custom mode the input value can
 * legitimately be empty (mid-edit) or even match a preset URL — neither
 * should yank the user out of custom mode.
 *
 * Custom-URL commits are debounced (`CUSTOM_DEBOUNCE_MS`) so each
 * keystroke doesn't immediately persist (and instantiate a new
 * `Connection` keyed by the partial URL in `lib/connections.ts`).
 */
function RpcSelect({ label, presets, effective, value, onChange }: RpcSelectProps) {
  const [customMode, setCustomMode] = useState<boolean>(() => {
    return value !== '' && !presets.some(p => p.url === value)
  })

  const [draft, setDraft] = useState<string>(value)
  // Resync the draft when the committed `value` changes (adjust-during-render).
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(value)
  }

  const displayDefault = useMemo(() => {
    const match = presets.find(p => p.url === effective)
    return match?.url ?? presets[0]?.url ?? CUSTOM_SENTINEL
  }, [presets, effective])

  const inputRef = useRef<HTMLInputElement | null>(null)
  const prevCustomRef = useRef<boolean>(customMode)
  useEffect(() => {
    if (customMode && !prevCustomRef.current) {
      inputRef.current?.focus()
    }
    prevCustomRef.current = customMode
  }, [customMode])

  const selectedKey = customMode
    ? CUSTOM_SENTINEL
    : (presets.find(p => p.url === value)?.url ?? displayDefault)

  const onSelect = (next: string) => {
    if (next === CUSTOM_SENTINEL) {
      setCustomMode(true)
      return
    }
    setCustomMode(false)
    onChange(next || null)
  }

  useEffect(() => {
    if (!customMode) {
      return
    }
    if (draft === value) {
      return
    }
    const id = window.setTimeout(onChange, CUSTOM_DEBOUNCE_MS, draft || null)
    return () => window.clearTimeout(id)
    // onChange is stable (zustand setter); intentionally omitted.
    // eslint-disable-next-line react/exhaustive-deps
  }, [draft, customMode, value])

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs font-medium text-foreground">{label}</label>
      <div className="relative">
        <select
          value={selectedKey}
          onChange={e => onSelect(e.target.value)}
          className="w-full appearance-none rounded-md border border-input bg-background px-3 py-2 pr-9 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {presets.map(preset => (
            <option key={preset.url} value={preset.url}>
              {preset.label}
            </option>
          ))}
          <option value={CUSTOM_SENTINEL}>Custom…</option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      </div>
      {customMode && (
        <Input
          ref={inputRef}
          type="url"
          inputMode="url"
          spellCheck={false}
          autoComplete="off"
          value={draft}
          placeholder="https://your-rpc.example.com"
          onChange={e => setDraft(e.target.value)}
          onBlur={() => onChange(draft || null)}
          aria-label={`${label} custom URL`}
          className="font-mono"
        />
      )}
      {customMode && draft === '' && (
        <p className="text-xs text-muted-foreground">
          Leave empty to use default.
        </p>
      )}
    </div>
  )
}
