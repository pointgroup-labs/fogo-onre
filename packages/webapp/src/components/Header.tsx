'use client'

import dynamic from 'next/dynamic'
import { APP_NAME } from '@/constants'
import ThemeToggle from './ThemeToggle'
import WalletButton from './WalletButton'

const SettingsSheet = dynamic(() => import('./SettingsSheet'), { ssr: false })

export default function Header() {
  return (
    <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
      <span className="overflow-hidden text-lg font-semibold tracking-tight">{APP_NAME}</span>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <SettingsSheet />
        <WalletButton />
      </div>
    </header>
  )
}
