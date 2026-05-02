'use client'

import { SessionButton } from '@fogo/sessions-sdk-react'
import { APP_NAME } from '@/lib/config'

export default function Header() {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
      <div className="text-lg font-semibold tracking-tight">{APP_NAME}</div>
      <SessionButton />
    </header>
  )
}
