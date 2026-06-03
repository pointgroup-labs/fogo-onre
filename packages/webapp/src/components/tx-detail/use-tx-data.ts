'use client'

import type { FlowStatus } from '@/hooks/useFlowStatus'
import type { RelayerFlowStatus } from '@/hooks/useRelayerFlowStatus'
import type { FogoDeliveryReceipt } from '@/lib/bridgeDelivery/fogoReceipt'
import type { DisplayAction } from '@/lib/bridgeHistory/bridgeAction'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'
import { isEstablished, isWalletLoading, useSession } from '@fogo/sessions-sdk-react'
import { PublicKey } from '@solana/web3.js'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { USDC_S_MINT } from '@/constants'
import { useBridgeHistory } from '@/hooks/useBridgeHistory'
import { useDepositUsdcAmount } from '@/hooks/useDepositUsdcAmount'
import { useFlowStatus } from '@/hooks/useFlowStatus'
import { useFogoDelivery } from '@/hooks/useFogoDelivery'
import { useRelayerFlowStatus } from '@/hooks/useRelayerFlowStatus'
import { findJournalEntryBySignature } from '@/lib/bridgeHistory/merge'

/**
 * Aggregates every data source that knows something about a single
 * bridge tx into one consumer-friendly shape.
 *
 * The detail page is opened from three distinct entry surfaces:
 *   1. A click in `BridgeHistory` — owner is connected, history is
 *      warmed, journal entry usually present.
 *   2. A reload on a previously-opened tab — owner connected, history
 *      cold, journal entry **might** be present.
 *   3. A shared link pasted on another device / cold session — owner
 *      possibly absent, journal entry definitely absent, history won't
 *      enumerate without an owner.
 *
 * We degrade gracefully across all three:
 *   - `action` is the canonical merged DisplayAction when available.
 *   - `journal` is the persisted client-side record (richer fields like
 *     baseline balance + amountStr, only present on the originating
 *     device).
 *   - `flow` is the live cross-chain `useFlowStatus` watcher, only
 *     enabled when journal data unlocks it.
 *   - `sessionEstablished` lets the page render a "connect wallet"
 *     prompt when none of the above can resolve.
 *   - `sessionInitializing` distinguishes "session is still booting"
 *     from "session is definitively disconnected" — without this, the
 *     page would flash a misleading "connect wallet" prompt during
 *     the SDK's Initializing → CheckingStoredSession → WalletConnecting
 *     boot sequence on every cold load.
 */
export interface TxDetail {
  signature: string
  action: DisplayAction | null
  journal: PersistedFlowStatus | null
  flow: FlowStatus | null
  /**
   * Journal-free deterministic FOGO-side delivery oracle. Resolves the
   * actual return-leg mint signature by enumerating the user's
   * destination ATA history — works on cold-share links and reloads
   * where `flow` (which needs a journal baseline) can't fire.
   */
  fogoDelivery: FogoDeliveryReceipt | null
  /**
   * Live relayer Flow sub-status on Solana (`Received` → `Swapped`), read via
   * a single filtered `getProgramAccounts`. Lets the timeline flip the Solana
   * step to `done` and the FOGO step to `active` the moment the swap lands,
   * instead of waiting for FOGO delivery. `null` before receive or after the
   * Flow PDA is closed (delivery then carries the signal).
   */
  relayerStatus: RelayerFlowStatus | null
  sessionEstablished: boolean
  /**
   * `true` while the wallet SDK is in any of its booting phases
   * (Initializing, CheckingStoredSession, WalletConnecting, etc.).
   * Distinct from `sessionEstablished === false` which conflates
   * "still booting" with "definitively disconnected".
   */
  sessionInitializing: boolean
  historyLoading: boolean
  /** True when the action truly isn't in the connected wallet's recent history. */
  notFound: boolean
}

export function useTxDetail(signature: string): TxDetail {
  const session = useSession()
  const sessionEstablished = isEstablished(session)
  // Treat *any* non-established loading state (Initializing,
  // CheckingStoredSession, WalletConnecting, RequestingLimits…) as
  // "still booting" — the SDK groups them all under `isWalletLoading`.
  // A previous version of the page treated all non-established as
  // "disconnected" and flashed a Connect-wallet prompt during boot.
  const sessionInitializing = !sessionEstablished && isWalletLoading(session)
  const owner = sessionEstablished ? session.walletPublicKey : null

  const qc = useQueryClient()
  const history = useBridgeHistory(owner)
  const action = useMemo(
    // Alias-based lookup: each action enumerates every sig that should
    // resolve to it (anchor, origin, destination, final, delivery
    // source). Keeps shared/saved URLs working without re-deriving the
    // disjunction at every call site.
    () => history.actions.find(a => a.aliases.has(signature)) ?? null,
    [history.actions, signature],
  )

  const journal = useMemo(
    // Orphan deposit-delivery actions are URL-keyed on the Solana
    // inbound sig, but the local journal is keyed on the FOGO burn
    // sig — fall through to `action.originSig` (back-filled in
    // useBridgeHistory) so same-device journal data still surfaces.
    () => findJournalEntryBySignature(qc, action?.originSig ?? signature),
    // `findJournalEntryBySignature` reads from the QueryClient cache, which
    // mutates without invalidating React-tree subscribers. The journal index
    // query (`['pending-flow-ids']`) inside `useBridgeHistory` already
    // subscribes us to additions; mirror its `actions` dep here so the
    // journal lookup re-runs when the index changes.
    // eslint-disable-next-line react/exhaustive-deps
    [qc, signature, history.actions, action?.originSig],
  )

  const flowInput = useMemo(() => {
    if (!journal) {
      return null
    }
    return {
      signature: journal.signature,
      owner: new PublicKey(journal.ownerB58),
      kind: journal.kind,
      startedAt: journal.startedAt,
      baselineBalance: BigInt(journal.baselineDestBalanceStr),
    }
  }, [journal])

  const flow = useFlowStatus(flowInput ?? {
    signature: null,
    owner: null,
    kind: journal?.kind ?? 'deposit',
    startedAt: null,
    baselineBalance: null,
  })

  // Journal-free delivery oracle. Inputs come from `action` (works on
  // cold-share / cross-device) with a journal fallback for cases where
  // the action hasn't merged in yet but the journal already has owner +
  // kind + signature. The hook itself is no-op when its inputs are
  // incomplete, so passing `null`s safely degrades.
  //
  // Short-circuit when the action already carries `finalSig`: that
  // value comes from Wormholescan's authoritative `targetChain.txHash`,
  // so the ATA-scan oracle has nothing to add and would happily latch
  // onto an unrelated *recent* mint for old shared URLs (the scan is
  // "since sourceBlockTime", not "around source"). Passing `null` for
  // `sourceSignature` is the hook's existing disable channel.
  const kind = action?.kind ?? journal?.kind ?? 'deposit'
  const ownerB58 = action !== null
    ? (session && isEstablished(session) ? session.walletPublicKey.toBase58() : null)
    : journal?.ownerB58 ?? null
  const sourceBlockTime = action?.startedAt ?? (journal ? Math.floor(journal.startedAt / 1000) : null)
  const oracleSourceSig = action?.finalSig != null ? null : signature
  const fogoDelivery = useFogoDelivery({
    ownerB58,
    kind,
    sourceSignature: oracleSourceSig,
    sourceBlockTime,
  })

  // Live relayer sub-status (Received → Swapped). Polls a single filtered
  // getProgramAccounts and stops the instant FOGO delivery is confirmed
  // (`fogoDelivery` non-null) or the swap lands. Gives the timeline a true
  // mid-bridge signal without depending on Wormholescan.
  const relayerStatus = useRelayerFlowStatus({
    ownerB58,
    kind,
    delivered: fogoDelivery !== null || flow?.phase === 'delivered',
  })

  // Orphan deposit-delivery rows arrive carrying the inbound ONyc amount
  // (Wormholescan can't see the paymaster-wrapped USDC burn). The exact
  // USDC is recovered lazily here — ~3 Solana RPC calls for this one open
  // row — instead of eagerly for every history-list row. Skipped when a
  // same-device journal already supplied USDC (`displayMintB58` is USDC).
  const needsUsdcRecovery = action !== null
    && action.kind === 'deposit'
    && action.anchorChain === 'Solana'
    && action.displayMintB58 !== USDC_S_MINT.toBase58()
  const recoveredUsdc = useDepositUsdcAmount(needsUsdcRecovery ? action.anchorSig : null)
  const resolvedAction = useMemo(() => {
    if (action === null || recoveredUsdc === null) {
      return action
    }
    return { ...action, displayAmountRaw: recoveredUsdc, displayMintB58: USDC_S_MINT.toBase58() }
  }, [action, recoveredUsdc])

  // `notFound` requires *positive evidence* of absence. Two paths:
  //   1. Connected: history must have actually completed a fetch
  //      (`isFetched`), not merely `!isLoading` (which is true the
  //      instant the query is `enabled: false`, including the brief
  //      window before owner is wired in).
  //   2. Definitively disconnected: session has settled to a non-
  //      established state and isn't booting. History will never load
  //      without an owner, so journal/action are our only signals.
  // Without these gates, the page flashes "Transaction not found" on
  // the first render before either the session or the query has had a
  // chance to report.
  const sessionDefinitivelyAbsent = !sessionEstablished && !sessionInitializing
  const notFound = action === null
    && journal === null
    && (
      (sessionEstablished && history.isFetched)
      || sessionDefinitivelyAbsent
    )

  return {
    signature,
    action: resolvedAction,
    journal,
    flow,
    fogoDelivery,
    relayerStatus,
    sessionEstablished,
    sessionInitializing,
    historyLoading: history.isLoading,
    notFound,
  }
}
