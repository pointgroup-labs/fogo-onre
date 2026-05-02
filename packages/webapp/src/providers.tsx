'use client'

import type { ReactNode } from 'react'
import { FogoSessionProvider } from '@fogo/sessions-sdk-react'
import { APP_DOMAIN, BONYC_MINT, FOGO_RPC_URL, USDC_S_MINT } from '@/lib/config'

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <FogoSessionProvider
      network="mainnet"
      rpc={FOGO_RPC_URL}
      domain={APP_DOMAIN}
      tokens={[USDC_S_MINT, BONYC_MINT]}
      enableUnlimited
    >
      {children}
    </FogoSessionProvider>
  )
}
