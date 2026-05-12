import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import LiveJournalTracker from '@/components/LiveJournalTracker'
import Providers from '@/providers'
import './globals.css'

const TITLE = 'Fogo OnRe — yield from OnRe, on FOGO'
const DESCRIPTION
  = 'Deposit USDC on FOGO and earn yield from OnRe’s tokenized reinsurance product (ONyc) on Solana, bridged via Wormhole NTT.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'Fogo OnRe',
  // Webapp is a single-tab dapp; we don't want search engines indexing
  // the placeholder copy or the in-flight tx state surfaced by the URL.
  robots: { index: false, follow: false },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: TITLE,
    description: DESCRIPTION,
  },
}

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          {/*
            Headless. Mounted at the root so it survives navigation
            between `(main)` and `/tx/[signature]` — without this, the
            tracker would unmount when the user opens the detail page,
            and the journal entry would never advance to terminal
            (BridgeHistory shows "processing" forever even after the
            flow detail page shows "delivered").
          */}
          <LiveJournalTracker />
          {children}
        </Providers>
      </body>
    </html>
  )
}
