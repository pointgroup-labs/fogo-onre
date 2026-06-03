import type { OperationStatus } from './types'
import type { Classified, WormholescanOp } from './wormholescan-list'
import type { FlowKind, PersistedFlowStatus } from '@/lib/flow-status/types'
import { FOGO_ONYC_DECIMALS, FOGO_ONYC_MINT, USDC_DECIMALS, USDC_S_MINT } from '@/constants'
import {
  classifyOps,
  extractAmount,
  FOGO_CHAIN_ID,
  mapTargetStatus,
  PAIRING_SKEW_MS,
  PAIRING_WINDOW_MS,
  timestampToSeconds,
} from './wormholescan-list'

/**
 * `BridgeAction` is the canonical internal representation of "a user
 * round-trip on the bridge". It is produced from raw Wormholescan ops
 * by `classifyOpsIntoActions` and projected into the renderer-facing
 * `DisplayAction` shape by `decorateAction`, which layers in
 * device-local journal/dismiss overlays.
 *
 * Two anchoring rules, codified per kind because the data plane is
 * genuinely asymmetric:
 *
 *   - **Withdraw**: anchor on the user-signed FOGO ONyc burn (initiation).
 *     Wormholescan exposes this directly under the user's address.
 *     Pair its USDC delivery leg via time-proximity + token-leg.
 *   - **Deposit (paired)**: anchor on the user-signed FOGO USDC burn
 *     if-and-only-if Wormholescan surfaces it under the user's address.
 *     This only happens when the burn was NOT paymaster-wrapped.
 *   - **Deposit (orphan)**: anchor on the Solana ONyc lock (the visible
 *     delivery-leg source tx) when the burn was paymaster-wrapped. The
 *     user-signed FOGO source tx is invisible to address queries; the
 *     journal back-fills it later in `useBridgeHistory` Pass 0.
 *
 * The `aliases` field is the URL-stability contract. Every sig that
 * has historically routed to this action is enumerated here; the
 * detail page resolves `url.signature` against `aliases.has(sig)`,
 * which keeps shared/saved links working across the model swap.
 */
export interface BridgeAction {
  kind: FlowKind
  /** Display-anchor sig: row identity for click-through. */
  anchorSig: string
  /** Which chain `anchorSig` lives on (drives explorer choice). */
  anchorChain: 'FOGO' | 'Solana'
  /**
   * Every sig that should resolve to this action via the detail-page
   * lookup. Always includes `anchorSig`; also includes the outbound's
   * Solana arrival and the delivery's FOGO arrival when known. Mutable
   * during Pass 0 back-fill (journal sig is added there).
   */
  aliases: ReadonlySet<string>
  /**
   * Source-token raw amount (the side the user spent). Initially set
   * from Wormholescan's source-leg `extractAmount`. For orphan
   * deposit-delivery actions, `useBridgeHistory`'s queryFn re-stamps
   * this (and `sourceMintB58`) to the exact USDC principal recovered
   * from the Solana relayer's `UsdcClaimed` event before the action
   * leaves the page boundary — so consumers see USDC by the time
   * `decorateAction` runs.
   */
  sourceAmountRaw: bigint
  sourceMintB58: string
  /**
   * Initiation timestamp in seconds. For paired actions this is the
   * outbound burn's `sourceChain.timestamp`; for orphan deposits it's
   * the Solana ONyc-lock's `sourceChain.timestamp`, which is ~seconds
   * after the (invisible) FOGO USDC burn.
   */
  startedAt: number
  status: OperationStatus['kind']
  /** Outbound's Solana-side arrival (NTT destination tx), when known. */
  destinationSig: string | null
  /** Delivery's FOGO-side arrival (user-side mint/credit tx), when known. */
  finalSig: string | null
  /**
   * User-signed FOGO source burn sig, when knowable. Equals `anchorSig`
   * for paired (FOGO-anchored) actions; null for orphan deposit-
   * deliveries until `useBridgeHistory` Pass 0 back-fills it from a
   * same-device journal match.
   */
  originSig: string | null
}

/**
 * Display projection of a `BridgeAction`. Layers in device-local
 * overlays — journal-typed principal, journal phase, manual dismiss —
 * that the indexer can't know about. Decoupled from `BridgeAction` so
 * the wire-shape stays a pure function of Wormholescan + journal facts
 * while the renderer-facing shape can carry whatever derived display
 * state is convenient.
 *
 * `displayAmountRaw` / `displayMintB58` shadow `sourceAmountRaw` /
 * `sourceMintB58` rather than overwriting them: the journal overlay
 * swaps both amount and mint atomically (a paired deposit's source-leg
 * USDC amount supersedes the inbound ONyc display), and keeping the
 * raw indexer values around is useful for diagnostics.
 */
export interface DisplayAction extends BridgeAction {
  displayAmountRaw: bigint
  displayMintB58: string
  /** Non-terminal journal phase label; null when oracle-delivered, dismissed, or no journal. */
  phase: string | null
  /** User has explicitly marked this delivered via the dismiss affordance. */
  manuallyDismissed: boolean
  /**
   * Device-local journal reached `terminal-success` — i.e. this device's
   * own `LiveJournalTracker` saw the destination-ATA balance bump (the
   * `useFlowStatus` `balance > baseline` oracle, false-positives
   * impossible). Authoritative delivery proof that is independent of
   * Wormholescan, which never indexes OnRe's custom relayer-CPI redeem
   * and so leaves `status` stuck on `pending` forever.
   */
  journalDelivered: boolean
  /**
   * Destination-ATA balance scan confirmed delivery for this row,
   * independent of both Wormholescan and any local journal. Overlaid in
   * `useBridgeHistory` (the pure decorator has no RPC access, so it
   * defaults this `false`). This is the only delivery oracle available
   * for cross-device / cold-link rows that have no `terminal-success`
   * journal on this device.
   */
  chainDelivered: boolean
}

/**
 * Produce `BridgeAction[]` from a Wormholescan page. Outbound burns pair
 * with their delivery legs greedily — each burn (oldest first) claims its
 * nearest unconsumed delivery of the matching token within
 * `[-PAIRING_SKEW_MS, PAIRING_WINDOW_MS]`; unpaired inbounds become
 * standalone delivery/orphan rows. NTT sequence is NOT a deterministic
 * pair pointer (codex review), so correlation is time-window + token-leg
 * + owner. Timestamp-only pairing is inherently ambiguous when a burn has
 * no delivery, but the 7-day window covers slow relayer recoveries.
 */
export function classifyOpsIntoActions(ops: WormholescanOp[], userB58: string): BridgeAction[] {
  const classified = classifyOps(ops, userB58)
  const inbounds = classified
    .filter(c => c.dir === 'inbound')
    .sort((a, b) => timestampToSeconds(a.op.sourceChain.timestamp) - timestampToSeconds(b.op.sourceChain.timestamp))
  const outbounds = classified
    .filter(c => c.dir === 'outbound')
    .sort((a, b) => timestampToSeconds(a.op.sourceChain.timestamp) - timestampToSeconds(b.op.sourceChain.timestamp))

  const consumedIds = new Set<string>()
  const actions: BridgeAction[] = []

  for (const out of outbounds) {
    const outMs = timestampToSeconds(out.op.sourceChain.timestamp) * 1000
    // Withdraw burn (ONyc) pairs with USDC delivery; visible deposit
    // burn (USDC) pairs with ONyc delivery. Paymaster-wrapped deposits
    // never appear as outbounds, so the deposit branch only fires when
    // the user signed the FOGO USDC burn directly.
    const wantInboundToken: 'usdc' | 'onyc' = out.token === 'onyc' ? 'usdc' : 'onyc'

    let match: Classified | undefined
    let bestDelta = Number.POSITIVE_INFINITY
    for (const cand of inbounds) {
      if (consumedIds.has(cand.op.id) || cand.token !== wantInboundToken) {
        continue
      }
      const candMs = timestampToSeconds(cand.op.sourceChain.timestamp) * 1000
      const delta = candMs - outMs
      if (delta < -PAIRING_SKEW_MS || delta > PAIRING_WINDOW_MS) {
        continue
      }
      const dist = Math.abs(delta)
      if (dist < bestDelta) {
        match = cand
        bestDelta = dist
      }
    }

    const action = makeOutboundAction(out, match)
    if (action !== null) {
      actions.push(action)
    }
    if (match !== undefined) {
      consumedIds.add(match.op.id)
    }
  }

  for (const inb of inbounds) {
    if (consumedIds.has(inb.op.id)) {
      continue
    }
    const action = makeInboundOnlyAction(inb)
    if (action !== null) {
      actions.push(action)
    }
  }

  return actions
}

function makeOutboundAction(out: Classified, delivery: Classified | undefined): BridgeAction | null {
  const sourceDecimals = out.token === 'onyc' ? FOGO_ONYC_DECIMALS : USDC_DECIMALS
  const sourceAmountRaw = extractAmount(out.op, sourceDecimals)
  if (sourceAmountRaw === null) {
    return null
  }
  const sourceMintB58 = out.token === 'onyc' ? FOGO_ONYC_MINT.toBase58() : USDC_S_MINT.toBase58()
  const kind: FlowKind = out.token === 'onyc' ? 'withdraw' : 'deposit'

  const anchorSig = out.op.sourceChain.transaction.txHash
  const destinationSig = out.op.targetChain?.transaction?.txHash ?? null
  const finalSig = delivery?.op.targetChain?.transaction?.txHash ?? null

  const aliases = new Set<string>([anchorSig])
  if (destinationSig !== null) {
    aliases.add(destinationSig)
  }
  if (finalSig !== null) {
    aliases.add(finalSig)
  }
  if (delivery !== undefined) {
    // The delivery's Solana source tx is the NTT lock_onyc / send_usdc
    // VAA emitter. Same-device callers may key on it.
    aliases.add(delivery.op.sourceChain.transaction.txHash)
  }

  return {
    kind,
    anchorSig,
    anchorChain: 'FOGO',
    aliases,
    sourceAmountRaw,
    sourceMintB58,
    startedAt: timestampToSeconds(out.op.sourceChain.timestamp),
    status: delivery !== undefined ? 'delivered' : 'pending',
    destinationSig,
    finalSig,
    originSig: anchorSig,
  }
}

function makeInboundOnlyAction(inb: Classified): BridgeAction | null {
  // Display amount comes from the delivery op itself; for orphan
  // deposit-deliveries this is the ONyc amount the user received,
  // which is honest if not what they "spent". Source-side USDC
  // recovery (journal overlay or relayer-event lookup) happens
  // downstream in `useBridgeHistory` / `HeroSummary`.
  const displayDecimals = inb.token === 'onyc' ? FOGO_ONYC_DECIMALS : USDC_DECIMALS
  const sourceAmountRaw = extractAmount(inb.op, displayDecimals)
  if (sourceAmountRaw === null) {
    return null
  }
  const sourceMintB58 = inb.token === 'onyc' ? FOGO_ONYC_MINT.toBase58() : USDC_S_MINT.toBase58()
  const kind: FlowKind = inb.token === 'onyc' ? 'deposit' : 'withdraw'

  const anchorSig = inb.op.sourceChain.transaction.txHash
  const finalSig = inb.op.targetChain?.transaction?.txHash ?? null

  const aliases = new Set<string>([anchorSig])
  if (finalSig !== null) {
    aliases.add(finalSig)
  }

  return {
    kind,
    anchorSig,
    anchorChain: inb.op.sourceChain.chainId === FOGO_CHAIN_ID ? 'FOGO' : 'Solana',
    aliases,
    sourceAmountRaw,
    sourceMintB58,
    startedAt: timestampToSeconds(inb.op.sourceChain.timestamp),
    status: mapTargetStatus(inb.op.targetChain?.status),
    destinationSig: null,
    finalSig,
    // FOGO-anchored inbounds are visible (non-paymaster) FOGO source
    // txs; their anchor IS the user's burn. Solana-anchored inbounds
    // (orphan deposit-deliveries) carry an unknown origin until Pass 0.
    originSig: inb.op.sourceChain.chainId === FOGO_CHAIN_ID ? anchorSig : null,
  }
}

/**
 * Synthesize an optimistic `BridgeAction` from a same-device journal
 * entry whose burn hasn't surfaced on Wormholescan yet. Used to render
 * "Submitting" / "In progress" rows before the indexer catches up
 * (typically several seconds plus our 30s history staleTime). Once the
 * canonical action shows up, dedup-by-signature drops the synthetic.
 */
export function actionFromJournal(j: PersistedFlowStatus): BridgeAction {
  const isDeposit = j.kind === 'deposit'
  const decimals = isDeposit ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
  const principal = parseAmountForDisplay(j.amountStr, decimals) ?? 0n
  const sourceMintB58 = isDeposit ? USDC_S_MINT.toBase58() : FOGO_ONYC_MINT.toBase58()
  return {
    kind: j.kind,
    anchorSig: j.signature,
    anchorChain: 'FOGO',
    aliases: new Set([j.signature]),
    sourceAmountRaw: principal,
    sourceMintB58,
    startedAt: Math.floor(j.startedAt / 1000),
    status: 'unknown',
    destinationSig: null,
    finalSig: null,
    originSig: j.signature,
  }
}

/**
 * Project a `BridgeAction` into the renderer-facing `DisplayAction` by
 * overlaying journal-known facts and the dismiss flag.
 *
 * Amount precedence:
 *   1. Journal principal (exact user-typed value) when present.
 *   2. Otherwise, the action's source-leg amount as reported by
 *      Wormholescan.
 *
 * Phase precedence: journal phase only when neither the oracle nor
 * a manual dismissal has independently confirmed delivery — matching
 * the `StatusBadge` rule so every consumer sees the same precedence.
 *
 * `journalDelivered` carries the device-local `terminal-success` signal
 * separately so the renderer can treat it as a positive delivery oracle
 * (Wormholescan can't see the custom-relayer redeem, so its `status`
 * never flips and must not be the only "delivered" source).
 */
export function decorateAction(
  action: BridgeAction,
  journal: PersistedFlowStatus | null,
  dismissed: ReadonlySet<string>,
): DisplayAction {
  const isDismissed = dismissed.has(action.anchorSig)
  const journalDelivered = journal?.status === 'terminal-success'
  const oracleDelivered = action.status === 'delivered' || isDismissed || journalDelivered

  let displayAmountRaw = action.sourceAmountRaw
  let displayMintB58 = action.sourceMintB58
  let phase: string | null = null

  if (journal !== null) {
    const journalMintB58 = journal.kind === 'deposit'
      ? USDC_S_MINT.toBase58()
      : FOGO_ONYC_MINT.toBase58()
    const decimals = journal.kind === 'deposit' ? USDC_DECIMALS : FOGO_ONYC_DECIMALS
    const principal = parseAmountForDisplay(journal.amountStr, decimals)
    if (principal !== null) {
      displayAmountRaw = principal
      displayMintB58 = journalMintB58
    }
    if (!oracleDelivered) {
      phase = humanPhaseFromStatus(journal)
    }
  }

  return {
    ...action,
    displayAmountRaw,
    displayMintB58,
    phase,
    manuallyDismissed: isDismissed,
    journalDelivered,
    chainDelivered: false,
  }
}

function humanPhaseFromStatus(j: PersistedFlowStatus): string | null {
  switch (j.status) {
    case 'pending':
      return 'Submitting'
    case 'in-progress':
      return 'In progress'
    case 'terminal-success':
      return null
    case 'terminal-failure':
      return null
  }
}

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
