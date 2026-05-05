'use client'

import { create } from 'zustand'

export type ToastKind = 'pending' | 'success' | 'error' | 'info'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  description?: string
  /** Optional explorer URL. Renders as "View tx" link inside the toast. */
  href?: string
}

export interface ToastsState {
  toasts: Toast[]
  push: (toast: Omit<Toast, 'id'> & { id?: string }) => string
  dismiss: (id: string) => void
  /** Replace any existing toast sharing this id (used for status transitions). */
  upsert: (toast: Toast) => void
}

const AUTO_DISMISS_MS: Record<ToastKind, number | null> = {
  pending: 30_000,
  success: 5_000,
  error: 8_000,
  info: 5_000,
}

let counter = 0
function nextId(): string {
  counter += 1
  return `t-${Date.now()}-${counter}`
}

export const useToastsStore = create<ToastsState>((set, get) => ({
  toasts: [],
  push: (input) => {
    const id = input.id ?? nextId()
    const toast: Toast = { ...input, id }
    set(state => ({ toasts: [...state.toasts.filter(t => t.id !== id), toast] }))
    scheduleAutoDismiss(toast, get().dismiss)
    return id
  },
  upsert: (toast) => {
    set(state => ({
      toasts: state.toasts.some(t => t.id === toast.id)
        ? state.toasts.map(t => (t.id === toast.id ? toast : t))
        : [...state.toasts, toast],
    }))
    scheduleAutoDismiss(toast, get().dismiss)
  },
  dismiss: id => set(state => ({ toasts: state.toasts.filter(t => t.id !== id) })),
}))

function scheduleAutoDismiss(toast: Toast, dismiss: (id: string) => void) {
  const ms = AUTO_DISMISS_MS[toast.kind]
  if (ms === null) {
    return
  }
  setTimeout(dismiss, ms, toast.id)
}
