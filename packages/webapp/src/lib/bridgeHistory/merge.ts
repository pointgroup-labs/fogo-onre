import type { QueryClient } from '@tanstack/react-query'
import type { BurnRow, OperationStatus, TimelineRow } from './types'
import type { PersistedFlowStatus } from '@/lib/flow-status/types'
import { FOGO_ONYC_DECIMALS, USDC_DECIMALS, USDC_S_MINT } from '@/constants'
import { readFlow, readIndex } from '@/lib/flow-status/store'

/**
 * Find the journal entry for a given burn signature, if any. Journal
 * entries are keyed on `flowId`, not signature, so this is an O(N)
 * scan of the index — N is small (≤ a handful of in-flight flows in
 * normal use), so the linear scan is fine.
 *
 * Returns terminal entries too: we want them as the source of truth
 * for the *amount* (the user's typed principal, not the gross burn
 * which includes the bridge fee). The phase pill is suppressed for
 * terminal entries inside `humanPhaseFromStatus` so the Wormholescan
 * "Delivered" badge still wins display precedence.
 */
export function findJournalEntryBySignature(
  qc: QueryClient,
  signature: string,
): PersistedFlowStatus | null {
  const ids = readIndex(qc)
  for (const id of ids) {
    const entry = readFlow(qc, id)
    if (entry !== undefined && entry.signature === signature) {
      return entry
    }
  }
  return null
}

/**
 * Pure: given the four inputs, produce one TimelineRow. Must be
 * deterministic — same inputs always yield the same output.
 *
 * Amount precedence:
 *   1. Journal principal (exact — what the user typed).
 *   2. Deposit + on-chain bridge fee known: `gross - fee` (approximate).
 *   3. Otherwise: on-chain burn delta as-is (withdraws never deduct;
 *      gross IS principal, so non-approximate).
 *
 * `feeRaw` is the live `FeeConfig.bridge_transfer_fee` for USDC.s,
 * `null` while still loading or if RPC failed.
 */
export function mergeRow(
  burn: BurnRow,
  op: OperationStatus | null,
  journal: PersistedFlowStatus | null,
  feeRaw: bigint | null,
): TimelineRow {
  const isDeposit = burn.mint.equals(USDC_S_MINT)
  const decimals = isDeposit ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const principalFromJournal = journal !== null
    ? parseAmountForDisplay(journal.amountStr, decimals)
    : null

  let amountRaw: bigint
  let amountIsApproximate: boolean
  if (principalFromJournal !== null) {
    amountRaw = principalFromJournal
    amountIsApproximate = false
  } else if (isDeposit && feeRaw !== null && burn.amountRaw > feeRaw) {
    amountRaw = burn.amountRaw - feeRaw
    amountIsApproximate = true
  } else {
    // Withdraw without journal: no fee deduction, gross IS principal.
    // Deposit without journal AND without known fee: best we can do is
    // gross; flag approximate so the UI prefixes `~`.
    amountRaw = burn.amountRaw
    amountIsApproximate = isDeposit
  }

  return {
    signature: burn.signature,
    // The user's burn mint determines the flow direction. Burning
    // USDC.s on FOGO = depositing into the protocol. Burning ONyc
    // on FOGO = withdrawing.
    kind: isDeposit ? 'deposit' : 'withdraw',
    amountRaw,
    amountIsApproximate,
    mintB58: burn.mint.toBase58(),
    blockTime: burn.blockTime,
    status: op?.kind ?? 'unknown',
    destinationSignature: op !== null && op.kind === 'delivered' ? op.destinationTxHash : null,
    phase: journal !== null ? humanPhaseFromStatus(journal) : null,
  }
}

/**
 * The journal stores `FlowStatusValue` ('pending' | 'in-progress' | …).
 * `BridgeHistory` wants a human label like "Bridging…" / "Submitting"
 * for in-flight rows.
 *
 * Returns null for terminal statuses so the row's badge precedence
 * (`phase ?? status`) hands off to the Wormholescan-derived
 * "Delivered" badge rather than shadowing it with a stale "Complete".
 */
function humanPhaseFromStatus(j: PersistedFlowStatus): string | null {
  switch (j.status) {
    case 'pending':
      return 'Submitting'
    case 'in-progress':
      return 'Bridging'
    case 'terminal-success':
      return null
    case 'terminal-failure':
      return null
  }
}

/**
 * Parse a user-typed amount string ("1", "1.5", "0.123456") into raw
 * units. Returns null on invalid input rather than throwing — display
 * code falls back to the on-chain delta if parsing fails. Less strict
 * than `useTransferMutation.parseAmountStrict` because we're consuming
 * already-validated journal data; tolerance for weirdness here is
 * preferable to crashing the row.
 */
function parseAmountForDisplay(amountStr: string, decimals: number): bigint | null {
  if (!/^\d*(?:\.\d*)?$/.test(amountStr) || amountStr === '') {
    return null
  }
  const [whole, fraction = ''] = amountStr.split('.')
  if (fraction.length > decimals) {
    return null
  }
  const padded = fraction.padEnd(decimals, '0')
  try {
    return BigInt(`${whole || '0'}${padded}`)
  } catch {
    return null
  }
}
