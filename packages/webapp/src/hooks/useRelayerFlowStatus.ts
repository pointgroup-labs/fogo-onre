'use client'

import { RELAYER_PROGRAM_ID } from '@fogo-onre/sdk'
import { useQuery } from '@tanstack/react-query'
import { useDocumentVisible } from '@/hooks/useDocumentVisible'
import { useSettings } from '@/store/settings'
import { getSolanaConnection } from '@/utils/connections'

/**
 * The two on-chain Flow sub-states the relayer ever persists. There is no
 * `Closed` variant — the Flow PDA is *deleted* when the send leg finalises
 * (rent reclaimed), so absence means either "receive hasn't run yet" or
 * "already delivered". The delivery watcher disambiguates that; this hook
 * only reports the live in-flight sub-state.
 */
export type RelayerFlowStatus = 'Received' | 'Swapped'

// Flow PDA byte layout (programs/relayer/src/state.rs):
//   disc(8) | recipient:Pubkey@8 | status@40 | amount@41 | payer@49 | bump@81 | direction@82
const FLOW_ACCOUNT_SIZE = 83
const RECIPIENT_OFFSET = 8
const STATUS_OFFSET = 40
// One slice from status@40 through direction@82 (inclusive) = 43 bytes.
const SLICE_OFFSET = STATUS_OFFSET
const SLICE_LENGTH = 43
const DIRECTION_INDEX = 82 - SLICE_OFFSET // 42

/**
 * Live relayer Flow sub-status for one user, read straight from Solana with
 * a single filtered `getProgramAccounts`. Lets the timeline distinguish
 * "received, converting" from "swapped, bridging back" — granularity the
 * FOGO-side delivery oracle can't see.
 *
 * RPC budget is deliberately tiny:
 *   - One memcmp on `recipient` + a `dataSize` filter narrows to this user's
 *     in-flight Flows server-side; a `dataSlice` ships only the 43 bytes we
 *     read, never the full account.
 *   - Polling auto-stops once `Swapped` is observed (no further on-chain
 *     granularity exists) and whenever the tab is hidden or delivery lands.
 *   - A typical flow makes 1–3 polls total, then goes quiet.
 */
export function useRelayerFlowStatus(input: {
  ownerB58: string | null
  kind: 'deposit' | 'withdraw'
  /** Pass the delivered flag so we stop polling the instant USDC lands on FOGO. */
  delivered: boolean
}): RelayerFlowStatus | null {
  const { ownerB58, kind, delivered } = input
  const visible = useDocumentVisible()
  const { solanaRpcUrl } = useSettings()

  const enabled = ownerB58 !== null && !delivered

  const query = useQuery({
    queryKey: ['relayer-flow-status', solanaRpcUrl, ownerB58, kind] as const,
    enabled,
    staleTime: 5_000,
    refetchInterval: (q) => {
      // Hidden tab or terminal sub-state → stop polling.
      if (!visible || q.state.data === 'Swapped') {
        return false
      }
      return 6_000
    },
    queryFn: async (): Promise<RelayerFlowStatus | null> => {
      const connection = getSolanaConnection(solanaRpcUrl)
      const accounts = await connection.getProgramAccounts(RELAYER_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [
          { dataSize: FLOW_ACCOUNT_SIZE },
          { memcmp: { offset: RECIPIENT_OFFSET, bytes: ownerB58! } },
        ],
        dataSlice: { offset: SLICE_OFFSET, length: SLICE_LENGTH },
      })

      const wantDirection = kind === 'deposit' ? 0 : 1
      let best: RelayerFlowStatus | null = null
      for (const { account } of accounts) {
        const data = account.data
        if (data.length < SLICE_LENGTH || data[DIRECTION_INDEX] !== wantDirection) {
          continue
        }
        const status: RelayerFlowStatus = data[0] === 1 ? 'Swapped' : 'Received'
        // Prefer the most-advanced sub-state if multiple in-flight Flows exist.
        if (status === 'Swapped') {
          return 'Swapped'
        }
        best = status
      }
      return best
    },
  })

  return query.data ?? null
}
