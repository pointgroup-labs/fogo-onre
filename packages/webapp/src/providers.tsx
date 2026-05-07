'use client'

/* eslint-disable perfectionist/sort-imports -- polyfill MUST be first */

// MUST be the first import — see comment in polyfills.ts.
import './polyfills'

import type { ReactNode } from 'react'

import { FogoSessionProvider } from '@fogo/sessions-sdk-react'
import { APP_DOMAIN, FOGO_ONYC_MINT, FOGO_NETWORK, USDC_S_MINT } from '@/constants'
import { useSettings } from '@/store/settings'

/* eslint-enable perfectionist/sort-imports */

export default function Providers({ children }: { children: ReactNode }) {
  // Subscribed read so a settings-drawer URL change re-renders here. The
  // `key={fogoRpcUrl}` forces a clean remount of FogoSessionProvider so
  // the wallet adapter rebuilds against the new endpoint without a page
  // reload.
  const { fogoRpcUrl } = useSettings()
  return (
    <FogoSessionProvider
      key={fogoRpcUrl}
      network={FOGO_NETWORK}
      rpc={fogoRpcUrl}
      domain={APP_DOMAIN}
      tokens={[USDC_S_MINT, FOGO_ONYC_MINT]}
      enableUnlimited
    >
      {children}
    </FogoSessionProvider>
  )
}
