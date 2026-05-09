'use client'

import type { ReactNode } from 'react'
import { Component } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

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
    // Logging the raw error + componentStack is useful in dev for fast
    // diagnosis but in production it can leak internals (file paths,
    // unminified component names if sourcemaps are present, etc.) to the
    // browser console where any user can copy them. We log a sanitized
    // single-line breadcrumb in prod and the full payload in dev only.
    if (process.env.NODE_ENV === 'production') {
      console.warn(
        `[ErrorBoundary]${this.props.label ? ` ${this.props.label}` : ''}: ${error.name}`,
      )
    } else {
      console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack)
    }
  }

  reset = () => {
    this.setState({ error: null })
  }

  render() {
    if (this.state.error === null) {
      return this.props.children
    }
    return (
      <Alert variant="destructive">
        <AlertTitle>
          Something went wrong
          {this.props.label ? ` in ${this.props.label}` : ''}
        </AlertTitle>
        <AlertDescription>{this.state.error?.message ?? 'Unknown error'}</AlertDescription>
        <Button className="mt-2" size="sm" variant="outline" onClick={this.reset}>Reload</Button>
      </Alert>
    )
  }
}
