'use client'

import type { PublicKey } from '@solana/web3.js'
import { isEstablished, isWalletLoading, SessionStateType, useSession } from '@fogo/sessions-sdk-react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

function shortAddress(pk: PublicKey): string {
  const s = pk.toBase58()
  return `${s.slice(0, 4)}…${s.slice(-4)}`
}

export default function WalletButton() {
  const state = useSession()

  if (isWalletLoading(state)) {
    return (
      <Button variant="outline" disabled>
        <Loader2 className="h-4 w-4 animate-spin" />
        Connecting…
      </Button>
    )
  }

  if (isEstablished(state)) {
    const full = state.walletPublicKey.toBase58()
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">{shortAddress(state.walletPublicKey)}</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => {
              void navigator.clipboard.writeText(full)
              toast.success('Address copied')
            }}
          >
            Copy address
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => state.endSession()}>
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  if (state.type === SessionStateType.NotEstablished) {
    return <Button onClick={() => state.establishSession()}>Connect wallet</Button>
  }

  return <Button disabled>Connect wallet</Button>
}
