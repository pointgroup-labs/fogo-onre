'use client'

import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import Link from 'next/link'
import Header from '@/components/Header'

/**
 * Chrome for the per-tx detail route. Deliberately lighter than the
 * `(main)` shell — no deposit/withdraw tabs, no protocol stats, no
 * bridge history (we're already looking at one row in detail). Keeping
 * the global `<Header />` preserves the wallet pill / theme toggle so
 * users don't lose session context when they drill into a row.
 *
 * The back-link uses `next/link` to `/` rather than `router.back()` —
 * shared-link arrivals (no history stack) wouldn't have anywhere to go
 * back to, and "Home" is always a sensible target.
 */
export default function TxDetailLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-md flex-col gap-4">
          <Link
            href="/"
            className="inline-flex w-fit items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft aria-hidden className="size-3.5" />
            Back to dashboard
          </Link>
          {children}
        </div>
      </main>
    </div>
  )
}
