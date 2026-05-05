'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSettings, useSettingsStore } from '@/store/settings'

interface SettingsDrawerProps {
  open: boolean
  onClose: () => void
}

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
 * Right-side slide-in settings panel. Subscribes to `useSettingsStore`
 * for live values; every change persists immediately via the store's
 * `persist` middleware, and downstream consumers (Connection singletons,
 * polling hooks, FogoSessionProvider) re-bind via the unified
 * `useSettings()` hook — no page reload required.
 */
export default function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const fogoRpcOverride = useSettingsStore(s => s.fogoRpcUrl)
  const solanaRpcOverride = useSettingsStore(s => s.solanaRpcUrl)
  const setFogoRpcUrl = useSettingsStore(s => s.setFogoRpcUrl)
  const setSolanaRpcUrl = useSettingsStore(s => s.setSolanaRpcUrl)
  const { fogoRpcUrl, solanaRpcUrl } = useSettings()

  const returnFocusRef = useRef<HTMLElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)

  // On open: remember the previously-focused element so we can restore
  // it on close, then focus the close button after the slide-in starts
  // so the focus ring doesn't fight the transform.
  useEffect(() => {
    if (!open) {
      return
    }
    returnFocusRef.current = document.activeElement as HTMLElement | null
    const id = window.setTimeout(() => closeButtonRef.current?.focus(), 50)
    return () => window.clearTimeout(id)
  }, [open])

  const handleClose = () => {
    onClose()
    // Defer focus restore until after the parent re-renders the trigger
    // back into the focusable tree.
    window.setTimeout(() => returnFocusRef.current?.focus(), 0)
  }

  // Esc to close, focus trap, body scroll lock. `handleClose` only
  // touches refs, so an `[open]`-only dep array is safe.
  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
        return
      }
      if (e.key !== 'Tab') {
        return
      }
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      if (!focusables || focusables.length === 0) {
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
    // eslint-disable-next-line react/exhaustive-deps
  }, [open])

  return (
    <div
      className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      <div
        onClick={handleClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-label="Settings"
        aria-modal="true"
        className={`absolute right-0 top-0 flex h-full w-full max-w-sm flex-col overflow-hidden border-l border-neutral-800 bg-neutral-950 shadow-2xl transition-transform duration-200 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-end px-6 py-4">
          <button
            ref={closeButtonRef}
            type="button"
            onClick={handleClose}
            aria-label="Close settings"
            className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-8 overflow-y-auto px-6 pb-8 pt-2 text-sm">
          <section className="flex flex-col gap-4">
            <SectionHeader title="Network" />
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
        </div>
      </aside>
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
      {title}
    </h3>
  )
}

const CUSTOM_SENTINEL = '__custom__'
const CUSTOM_DEBOUNCE_MS = 400

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

  // Local input draft for the custom URL. Only commits to the store
  // after the user stops typing for `CUSTOM_DEBOUNCE_MS`. Initialised
  // from the persisted value so the field shows what's saved on first
  // open into custom mode.
  const [draft, setDraft] = useState<string>(value)
  useEffect(() => {
    // External changes (e.g. user picks a preset) overwrite the draft so
    // we don't strand a stale custom URL in the field.
    setDraft(value)
  }, [value])

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
    // Empty string ("Default") collapses to null in the store so the
    // resolution chain falls through to env / hardcoded.
    onChange(next || null)
  }

  // Debounced commit of the custom-URL draft.
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
      <label className="text-xs font-medium text-neutral-300">{label}</label>
      <div className="relative">
        <select
          value={selectedKey}
          onChange={e => onSelect(e.target.value)}
          className="w-full appearance-none rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 pr-9 text-xs text-neutral-100 outline-none transition-colors hover:border-neutral-700 focus:border-neutral-500"
        >
          {presets.map(preset => (
            <option key={preset.url} value={preset.url}>
              {preset.label}
            </option>
          ))}
          <option value={CUSTOM_SENTINEL}>Custom…</option>
        </select>
        <ChevronIcon />
      </div>
      {customMode && (
        <input
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
          className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 font-mono text-xs text-neutral-100 outline-none transition-colors placeholder:text-neutral-600 hover:border-neutral-700 focus:border-neutral-500"
        />
      )}
      {customMode && draft === '' && (
        <p className="text-[10px] text-neutral-500">
          Leave empty to use default.
        </p>
      )}
    </div>
  )
}

function CloseIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg
      className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}
