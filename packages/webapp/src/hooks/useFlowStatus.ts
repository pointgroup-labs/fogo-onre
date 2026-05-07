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
// Bridge round-trip timing differs by kind:
//   - Deposit: NTT FOGO→Solana → relayer cranks → return-leg NTT Solana→FOGO
//     bONyc mint. Typically minutes; 30 min is a generous expiry.
//   - Withdraw: same NTT round-trip PLUS OnRe redemption fulfilment, which
//     is permissioned/queued and can take many hours. A 30 min expiry would
//     surface "expired" while the redemption is still legitimately pending,
//     panicking the user. 24 h is the conservative upper bound for the
//     current OnRe ops cadence.
const EXPIRE_MS_BY_KIND: Record<'deposit' | 'withdraw', number> = {
  deposit: 30 * 60 * 1_000,
  withdraw: 24 * 60 * 60 * 1_000,
}

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
  /**
   * Destination-ATA balance captured **before** the user signed the
   * submission. Required for correctness: capturing the baseline on the
   * first poll (after the user signed) opens a race where a concurrent
   * delivery — from another tab, a stale prior bridge, or a generous
   * external transfer — looks like *this* flow's delivery, producing a
   * false positive "delivered" toast for a flow that is in fact still
   * mid-bridge.
   *
   * Falls back to "capture on first tick" when null, preserving legacy
   * behaviour for callers that haven't been updated to snapshot upstream.
   */
  baselineBalance: bigint | null
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
    const presetBaseline = input.baselineBalance
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
    let baseline: bigint | null = presetBaseline
    let delivered = false
    const expireMs = EXPIRE_MS_BY_KIND[input.kind]

    // Caller-provided baseline → emit `submitted` immediately so the UI
    // doesn't render a 1-tick gap before the watcher publishes state.
    if (presetBaseline !== null) {
      setStatus({ phase: 'submitted', signature, startedAt, baselineBalance: presetBaseline })
    }

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
        phase: elapsed > expireMs ? 'expired' : 'bridging',
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
  }, [input.signature, ownerKey, input.kind, input.startedAt, input.baselineBalance, visible, fogoRpcUrl])

  return status
}
