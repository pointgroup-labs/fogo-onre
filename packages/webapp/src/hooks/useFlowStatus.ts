'use client'

import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import { useEffect, useState } from 'react'
import { BONYC_MINT, USDC_S_MINT } from '@/constants'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { useSettings } from '@/store/settings'
import { getFogoConnection } from '@/utils/connections'

/**
 * Cross-chain settlement is the long pole of this app: a FOGO `transfer_burn`
 * confirms in seconds, but bridged delivery (NTT message → Wormhole guardians
 * → Solana relayer cranks → return-leg NTT lock → FOGO mint) takes minutes
 * for deposits and can take hours for withdraws (OnRe redemption fulfilment).
 *
 * Truth would be: re-derive `nttInboxItem` from the message hash, then poll
 * the relayer's Flow PDA on Solana. But the message hash is *not* available
 * to a FOGO-side signer client — it's computed during VAA attestation,
 * after the user's tx already returned. Without a Wormhole VAA fetcher
 * (out of scope here), we use the next-best signal: the user's destination
 * ATA on FOGO. When that balance increases vs. the snapshot taken at submit
 * time, the cross-chain flow has *necessarily* delivered. False negatives
 * (delivered but balance also dropped from another tx in the window) are
 * acceptable; false positives are impossible — only the relayer can mint
 * the destination token.
 */

export type FlowPhase = 'submitted' | 'bridging' | 'delivered' | 'expired'

export interface FlowStatus {
  phase: FlowPhase
  signature: string
  startedAt: number
  baselineBalance: bigint | null
}

const POLL_MS = 10_000
const EXPIRE_MS = 30 * 60 * 1_000

async function readBalance(connection: Connection, ata: PublicKey): Promise<bigint | null> {
  try {
    const result = await connection.getTokenAccountBalance(ata, 'confirmed')
    return BigInt(result.value.amount)
  } catch {
    return 0n
  }
}

export interface FlowWatchInput {
  signature: string | null
  owner: PublicKey | null
  kind: 'deposit' | 'withdraw'
  startedAt: number | null
}

export function useFlowStatus(input: FlowWatchInput): FlowStatus | null {
  const ownerKey = input.owner?.toBase58() ?? null
  const [status, setStatus] = useState<FlowStatus | null>(null)
  const visible = useDocumentVisible()
  // Subscribe so a settings change rebinds the polling loop against the
  // new endpoint immediately.
  const { fogoRpcUrl } = useSettings()

  useEffect(() => {
    // Capture validated values into local consts so the inner closures
    // can use them without `!` non-null assertions.
    const signature = input.signature
    const startedAt = input.startedAt
    if (signature === null || ownerKey === null || startedAt === null) {
      setStatus(null)
      return
    }

    let cancelled = false
    let intervalId: ReturnType<typeof setInterval> | null = null
    const ownerPk = new PublicKey(ownerKey)
    const connection = getFogoConnection(fogoRpcUrl)
    // Deposit: user receives bONyc on FOGO. Withdraw: user receives USDC.s.
    const destinationMint = input.kind === 'deposit' ? BONYC_MINT : USDC_S_MINT
    const destAta = getAssociatedTokenAddressSync(destinationMint, ownerPk)
    let baseline: bigint | null = null
    let delivered = false

    const stop = () => {
      cancelled = true
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
    }

    const tick = async () => {
      if (cancelled || delivered) {
        return
      }
      const balance = await readBalance(connection, destAta)
      if (cancelled) {
        return
      }
      if (baseline === null) {
        baseline = balance
        setStatus({ phase: 'submitted', signature, startedAt, baselineBalance: balance })
        return
      }
      if (balance !== null && balance > baseline) {
        delivered = true
        setStatus({ phase: 'delivered', signature, startedAt, baselineBalance: baseline })
        stop()
        return
      }
      const elapsed = Date.now() - startedAt
      setStatus({
        phase: elapsed > EXPIRE_MS ? 'expired' : 'bridging',
        signature,
        startedAt,
        baselineBalance: baseline,
      })
    }

    tick()
    if (visible) {
      intervalId = setInterval(tick, POLL_MS)
    }
    return stop
  }, [input.signature, ownerKey, input.kind, input.startedAt, visible, fogoRpcUrl])

  return status
}
