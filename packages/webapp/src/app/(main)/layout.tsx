'use client'

import type { ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useCallback } from 'react'
import BridgeHistory from '@/components/BridgeHistory'
import ErrorBoundary from '@/components/ErrorBoundary'
import Header from '@/components/Header'
import LiveJournalTracker from '@/components/LiveJournalTracker'
import ProtocolStats from '@/components/ProtocolStats'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

type TabKind = 'deposit' | 'withdraw'

// User-facing vocabulary diverges from the internal discriminant:
//   - Discriminant `'withdraw'` (matches `FlowKind` across SDK, journal,
//     cranker, on-chain types — renaming it is a cross-package refactor).
//   - Route segment `/redeem` (URL is user-visible; matches OnRe's app).
//   - Display label "Redeem" (matches OnRe's vocabulary).
// Keep these three views aligned via these helper functions, and don't
// chase the discriminant rename here.
function pathToTab(pathname: string): TabKind {
  return pathname === '/redeem' ? 'withdraw' : 'deposit'
}

function tabToPath(tab: TabKind): string {
  return tab === 'withdraw' ? '/redeem' : '/'
}

/**
 * Shared shell for the deposit / withdraw routes. Lives in a route
 * group (`(main)`) so it wraps both `/` and `/withdraw` without adding
 * a URL segment. Header, stats, tab nav, journal tracker, and bridge
 * history are all rendered here so they survive route changes — only
 * the inner `{children}` slot remounts when the user navigates between
 * tabs. That preserves component state (scroll, query subscriptions,
 * balance WS connections) and avoids re-fetching anything on toggle.
 *
 * Tabs are *visual* only — `onValueChange` routes via `router.push`
 * rather than driving internal `<Tabs>` state. Radix `<Tabs>` is kept
 * for the styling primitives (`TabsList` / `TabsTrigger`); we omit
 * `TabsContent` entirely because the route IS the content.
 */
export default function MainLayout({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const tab = pathToTab(pathname)

  const handleTabChange = useCallback((next: string) => {
    const value: TabKind = next === 'withdraw' ? 'withdraw' : 'deposit'
    if (value === tab) {
      return
    }
    router.push(tabToPath(value), { scroll: false })
  }, [router, tab])

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-12 sm:px-6">
        <div className="mx-auto flex max-w-md flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Yield from OnRe</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Deposit USDC on FOGO and earn yield backed by real-world reinsurance premiums.
            </p>
          </div>
          <ErrorBoundary label="protocol stats"><ProtocolStats /></ErrorBoundary>
          <Tabs value={tab} onValueChange={handleTabChange} className="gap-4">
            <TabsList className="grid w-full grid-cols-2 p-1.5 group-data-horizontal/tabs:h-12">
              <TabsTrigger value="deposit" className="h-full text-sm font-semibold">Deposit</TabsTrigger>
              <TabsTrigger value="withdraw" className="h-full text-sm font-semibold">Redeem</TabsTrigger>
            </TabsList>
          </Tabs>
          {children}
          <LiveJournalTracker />
          <ErrorBoundary label="bridge history"><BridgeHistory /></ErrorBoundary>
        </div>
      </main>
      <footer className="border-t px-4 py-4 text-xs text-muted-foreground sm:px-6">
        <nav aria-label="Footer" className="mx-auto flex max-w-md flex-wrap items-center justify-center gap-x-5 gap-y-1">
          <FooterLink href="https://onre.finance">OnRe</FooterLink>
          <FooterLink href="https://docs.onre.finance/technical-resources/token-configuration-and-reference">OnRe Docs</FooterLink>
          <FooterLink href="https://app.onre.finance/earn/transparency">Transparency</FooterLink>
          <FooterLink href="https://github.com/pointgroup-labs/fogo-onre">GitHub</FooterLink>
          <FooterLink href="https://github.com/pointgroup-labs/fogo-onre/blob/main/docs/security.md">Security</FooterLink>
        </nav>
      </footer>
    </div>
  )
}

function FooterLink({ href, children }: { href: string, children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-muted-foreground transition-colors hover:text-foreground">
      {children}
    </a>
  )
}
