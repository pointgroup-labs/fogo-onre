'use client'

import ErrorBoundary from '@/components/ErrorBoundary'
import Header from '@/components/Header'
import PendingTxList from '@/components/PendingTxList'
import ProtocolStats from '@/components/ProtocolStats'
import TransferCard from '@/components/TransferCard'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

export default function Page() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="flex-1 px-4 py-12 sm:px-6">
        <div className="mx-auto flex max-w-md flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Yield from OnRe</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Deposit USDC.s on FOGO and earn yield backed by real-world reinsurance premiums.
            </p>
          </div>
          <ErrorBoundary label="protocol stats"><ProtocolStats /></ErrorBoundary>
          <Tabs defaultValue="deposit">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="deposit">Deposit</TabsTrigger>
              <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
            </TabsList>
            <TabsContent value="deposit">
              <ErrorBoundary label="deposit"><TransferCard kind="deposit" /></ErrorBoundary>
            </TabsContent>
            <TabsContent value="withdraw">
              <ErrorBoundary label="withdraw"><TransferCard kind="withdraw" /></ErrorBoundary>
            </TabsContent>
          </Tabs>
          <ErrorBoundary label="recent transactions"><PendingTxList /></ErrorBoundary>
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
