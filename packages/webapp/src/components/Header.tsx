'use client'

import dynamic from 'next/dynamic'
import { APP_NAME } from '@/constants'
import ThemeToggle from './ThemeToggle'
import WalletButton from './WalletButton'

const SettingsSheet = dynamic(() => import('./SettingsSheet'), { ssr: false })

export default function Header() {
  return (
    <header className="border-b">
      <div className="mx-auto flex max-w-screen-md items-center justify-between px-4 py-3">
        <div className="font-semibold tracking-tight">{APP_NAME}</div>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <SettingsSheet />
          <WalletButton />
        </div>
      </div>
    </header>
  )
}
