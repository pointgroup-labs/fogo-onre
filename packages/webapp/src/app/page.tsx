'use client'

import { Suspense, useRef, useState } from 'react'
import ErrorBoundary from '@/components/ErrorBoundary'
import Header from '@/components/Header'
import PendingTxList from '@/components/PendingTxList'
import ProtocolStats from '@/components/ProtocolStats'
import ToastHost from '@/components/ToastHost'
import TransferCard from '@/components/TransferCard'

type Tab = 'deposit' | 'withdraw'

const TABS: readonly Tab[] = ['deposit', 'withdraw']

export default function Page() {
  const [tab, setTab] = useState<Tab>('deposit')

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 px-4 py-12 sm:px-6">
        <div className="mx-auto max-w-md flex flex-col gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Yield from OnRe</h1>
            <p className="mt-1 text-sm text-neutral-400">
              Deposit USDC.s on FOGO and earn yield backed by real-world reinsurance premiums.
            </p>
          </div>
          <ErrorBoundary label="protocol stats">
            <Suspense fallback={null}>
              <ProtocolStats />
            </Suspense>
          </ErrorBoundary>
          <Tabs active={tab} onChange={setTab} />
          <ErrorBoundary label={tab}>
            <TransferCard kind={tab} />
          </ErrorBoundary>
          <ErrorBoundary label="recent transactions">
            <PendingTxList />
          </ErrorBoundary>
        </div>
      </main>
      <footer className="border-t border-neutral-800 px-4 py-4 text-xs text-neutral-500 sm:px-6">
        <nav
          aria-label="Footer"
          className="mx-auto flex max-w-md flex-wrap items-center justify-center gap-x-5 gap-y-1"
        >
          <FooterLink href="https://onre.finance">OnRe</FooterLink>
          <FooterLink href="https://docs.onre.finance/technical-resources/token-configuration-and-reference">
            OnRe Docs
          </FooterLink>
          <FooterLink href="https://app.onre.finance/earn/transparency">Transparency</FooterLink>
          <FooterLink href="https://github.com/pointgroup-labs/fogo-onre">GitHub</FooterLink>
          <FooterLink
            href="https://github.com/pointgroup-labs/fogo-onre/blob/main/docs/security.md"
          >
            Security
          </FooterLink>
        </nav>
      </footer>
      <ToastHost />
    </div>
  )
}

function Tabs({ active, onChange }: { active: Tab, onChange: (t: Tab) => void }) {
  // Keyed map of button refs so the arrow-key handler can move focus to
  // the newly-active tab. `useRef` (not `useState`) because we never
  // need to render in response to ref mutations.
  const buttonsRef = useRef<Record<Tab, HTMLButtonElement | null>>({ deposit: null, withdraw: null })

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = TABS.indexOf(active)
    if (idx === -1) {
      return
    }
    let nextIdx: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      nextIdx = (idx + 1) % TABS.length
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      nextIdx = (idx - 1 + TABS.length) % TABS.length
    } else if (e.key === 'Home') {
      nextIdx = 0
    } else if (e.key === 'End') {
      nextIdx = TABS.length - 1
    }
    if (nextIdx === null) {
      return
    }
    e.preventDefault()
    const next = TABS[nextIdx]
    onChange(next)
    buttonsRef.current[next]?.focus()
  }

  return (
    <div
      role="tablist"
      aria-label="Action"
      onKeyDown={onKeyDown}
      className="grid grid-cols-2 rounded-lg border border-neutral-800 bg-neutral-950 p-1 text-sm font-medium"
    >
      {TABS.map(value => (
        <TabButton
          key={value}
          ref={(el) => {
            buttonsRef.current[value] = el
          }}
          current={active}
          value={value}
          onChange={onChange}
          label={value === 'deposit' ? 'Deposit' : 'Withdraw'}
        />
      ))}
    </div>
  )
}

const ACTIVE_TAB_CLASS = 'bg-neutral-100 text-black'

function FooterLink({ href, children }: { href: string, children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-neutral-400 transition-colors hover:text-neutral-100"
    >
      {children}
    </a>
  )
}

function TabButton({
  ref,
  current,
  value,
  onChange,
  label,
}: {
  ref: (el: HTMLButtonElement | null) => void
  current: Tab
  value: Tab
  onChange: (t: Tab) => void
  label: string
}) {
  const isActive = current === value
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={() => onChange(value)}
      className={`rounded-md py-2 transition-colors ${
        isActive ? ACTIVE_TAB_CLASS : 'text-neutral-400 hover:text-neutral-100'
      }`}
    >
      {label}
    </button>
  )
}
