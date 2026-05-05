'use client'

import type { ReactNode } from 'react'
import { Component } from 'react'

/**
 * Top-level error boundary. Catches render-time exceptions in the
 * deposit/withdraw tree so a malformed quote / hook explosion can't
 * blank the entire page. Class component because React still has no
 * hook equivalent for `componentDidCatch`.
 *
 * We intentionally don't auto-recover — cross-chain UI state (last
 * submission, pending-tx list) is too important to silently retry on.
 * A visible reload button puts the user in control.
 */
interface Props {
  children: ReactNode
  /** Optional label so multiple boundaries can disambiguate in the UI. */
  label?: string
}

interface State {
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack)
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error === null) {
      return this.props.children
    }
    return (
      <section className="rounded-xl border border-red-900/60 bg-red-950/40 p-6 text-sm text-red-200">
        <h2 className="text-base font-semibold text-red-100">
          Something broke
          {this.props.label ? ` in ${this.props.label}` : ''}
          .
        </h2>
        <p className="mt-2 break-words font-mono text-xs text-red-300/80">
          {this.state.error.message}
        </p>
        <p className="mt-3 text-xs text-red-300/60">
          Your wallet and pending transactions are safe — this is a UI render
          error, not an on-chain failure. Reloading clears the error state.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-md border border-red-800 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-900/40"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => globalThis.location?.reload()}
            className="rounded-md bg-red-100 px-3 py-1.5 text-xs font-semibold text-red-900 hover:bg-white"
          >
            Reload page
          </button>
        </div>
      </section>
    )
  }
}
