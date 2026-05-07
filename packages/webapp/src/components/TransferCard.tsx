'use client'

import type { TransferKind } from '@/hooks/useFogoNttTransfer'
import { isEstablished, useSession } from '@fogo/sessions-sdk-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import AmountInput from '@/components/AmountInput'
import ReceiveField from '@/components/ReceiveField'
import { FOGO_ONYC_DECIMALS, FOGO_ONYC_DEPLOYMENT_READY, USDC_DECIMALS } from '@/constants'
import { useBalances } from '@/hooks/useBalances'
import { useBridgeFee } from '@/hooks/useBridgeFee'
import { useFlowStatus } from '@/hooks/useFlowStatus'
import { useFogoNttTransfer } from '@/hooks/useFogoNttTransfer'
import { useProtocolState } from '@/hooks/useProtocolState'
import { createDepositBridgeContextProvider } from '@/lib/bridge/depositContext'
import { usePendingTxsStore } from '@/store/pending-txs'
import { useToastsStore } from '@/store/toasts'
import { fogoTxUrl, shortSig, wormholeTxUrl } from '@/utils/explorers'
import { safeQuoteDeposit, safeQuoteWithdraw } from '@/utils/quote'
import { formatAmount, parseAmount } from '@/utils/transfer'

/**
 * Fires `fn` exactly once per *change* of `key`, ignoring re-renders
 * where `key` is identical to the last value handled. The handler reads
 * any other context it needs from refs (or stable store actions), so
 * unrelated dep churn — like the `kind` flipping when the user switches
 * tabs — never re-triggers it.
 *
 * Why this exists: standard `useEffect(fn, [a, b, c])` re-runs whenever
 * any* dep changes, even if the value the effect actually cares about
 * (`a`) hasn't moved. That caused duplicate toasts on tab switch — the
 * status was still `error` from a previous submit, but the effect
 * re-fired because `kind`/labels changed and pushed another toast.
 */
function useTransitionEffect<K>(key: K, fn: (key: K) => void) {
  const fnRef = useRef(fn)
  fnRef.current = fn
  const lastRef = useRef<{ value: K } | null>(null)
  useEffect(() => {
    if (lastRef.current !== null && lastRef.current.value === key) {
      return
    }
    lastRef.current = { value: key }
    fnRef.current(key)
  }, [key])
}

/**
 * Unified deposit/withdraw card. Replaces the previous DepositCard +
 * WithdrawCard pair, which were 95% duplicate code that drifted every
 * time we touched one and forgot the other.
 *
 * Pulls `append` / `markDelivered` directly from the pending-txs store
 * — no prop drilling — so the parent only has to mount us with `kind`.
 */

interface TransferCardProps {
  kind: TransferKind
}

interface KindUi {
  inputSymbol: string
  inputDecimals: number
  outputSymbol: string
  outputDecimals: number
  submitLabel: string
  submittingLabel: string
  insufficientLabel: string
  /** True when the on-chain endpoints this kind talks to are real. */
  ready: boolean
  /** Shown in place of the form when `ready` is false. */
  unavailable: { title: string, description: string } | null
}

const KIND_UI: Record<TransferKind, KindUi> = {
  deposit: {
    inputSymbol: 'USDC.s',
    inputDecimals: USDC_DECIMALS,
    outputSymbol: 'ONyc',
    outputDecimals: FOGO_ONYC_DECIMALS,
    submitLabel: 'Deposit',
    submittingLabel: 'Depositing…',
    insufficientLabel: 'Insufficient USDC.s',
    ready: true,
    unavailable: null,
  },
  withdraw: {
    inputSymbol: 'ONyc',
    inputDecimals: FOGO_ONYC_DECIMALS,
    outputSymbol: 'USDC.s',
    outputDecimals: USDC_DECIMALS,
    submitLabel: 'Withdraw',
    submittingLabel: 'Withdrawing…',
    insufficientLabel: 'Insufficient ONyc',
    ready: FOGO_ONYC_DEPLOYMENT_READY,
    unavailable: FOGO_ONYC_DEPLOYMENT_READY
      ? null
      : {
          title: 'Withdrawals coming soon',
          description: 'The FOGO-side ONyc bridge isn\'t live yet. Deposits work today; you\'ll be able to redeem here once it ships.',
        },
  },
}

export default function TransferCard({ kind }: TransferCardProps) {
  const sessionState = useSession()
  // Build the deposit-side bridge-context provider once per mount. The
  // factory closes over env-driven config (executor URL, fee accounts,
  // etc.); see `lib/bridge/depositContext.ts` for the full list of
  // values it needs and how they're resolved. Withdraw branch passes
  // `null` because that path doesn't go through `bridge_ntt_tokens`.
  const bridgeContextProvider = useMemo(
    () => kind === 'deposit' ? createDepositBridgeContextProvider() : null,
    [kind],
  )
  const { status, submit, lastSubmission } = useFogoNttTransfer(
    kind,
    sessionState,
    { bridgeContextProvider },
  )
  const protocol = useProtocolState()
  const { snapshot: balances, refresh: refreshBalances } = useBalances(sessionState)
  const appendPendingTx = usePendingTxsStore(s => s.append)
  const markDelivered = usePendingTxsStore(s => s.markDelivered)
  const upsertToast = useToastsStore(s => s.upsert)
  const dismissToast = useToastsStore(s => s.dismiss)
  const [input, setInput] = useState('')

  const ui = KIND_UI[kind]
  const sessionEstablished = isEstablished(sessionState)
  const owner = sessionEstablished ? sessionState.walletPublicKey : null
  const sourceBalance = kind === 'deposit' ? balances.usdc : balances.fogoOnyc

  // Pulled here (not just inside BridgeFeeRow) because the deposit
  // Submit gate has to refuse when the user can't cover the bridged
  // amount + bridge fee out of the same USDC.s balance — fee_mint is
  // USDC.s, so feeSource = sourceAta and the on-chain SPL transfer
  // pulls `amount + fee` out of one ATA. The gate is folded into the
  // existing `insufficient` calc below.
  const bridgeFee = useBridgeFee()

  const flow = useFlowStatus({
    signature: lastSubmission?.signature ?? null,
    owner,
    kind,
    startedAt: lastSubmission?.startedAt ?? null,
    baselineBalance: lastSubmission?.baselineBalance ?? null,
  })

  // Persist on submission. Only fires on a *new* `lastSubmission`
  // reference so that tab switches (which re-render with the same
  // submission) don't re-record the pending tx.
  useTransitionEffect(lastSubmission, (submission) => {
    if (!submission) {
      return
    }
    appendPendingTx({
      signature: submission.signature,
      kind,
      amount: submission.amount.toString(),
      submittedAt: submission.startedAt,
      delivered: false,
    })
    // Source-side balance just dropped — kick a refetch so the UI
    // doesn't show stale numbers for up to 15s while the next poll fires.
    refreshBalances()
  })

  // Mark delivered when the watcher fires. Keyed on phase+signature so
  // identical poll ticks don't re-run the store update / refetch.
  useTransitionEffect(`${flow?.phase ?? ''}:${flow?.signature ?? ''}`, () => {
    if (flow?.phase === 'delivered') {
      markDelivered(flow.signature)
      refreshBalances()
    }
  })

  // Submit lifecycle → toasts. Keyed on the `status` reference (a fresh
  // object per `setStatus` call), so re-renders that don't represent a
  // status transition — e.g. tab switches — are no-ops.
  useTransitionEffect(status, (current) => {
    const pendingId = `tx-${kind}-pending`
    if (current.kind === 'pending') {
      upsertToast({
        id: pendingId,
        kind: 'pending',
        title: ui.submittingLabel,
      })
      return
    }
    if (current.kind === 'error') {
      dismissToast(pendingId)
      upsertToast({
        id: `tx-${kind}-error-${current.message}`,
        kind: 'error',
        title: 'Transaction failed',
        description: current.message,
      })
      return
    }
    if (current.kind === 'success') {
      dismissToast(pendingId)
      setInput('')
      upsertToast({
        id: `tx-${kind}-${current.signature}`,
        kind: 'pending',
        title: 'Submitted — bridging…',
        description: shortSig(current.signature),
        href: fogoTxUrl(current.signature),
      })
    }
  })

  // Cross-chain settlement → mutate the same per-signature toast in place.
  // Keyed on phase+signature so flow-poll re-renders without a transition
  // don't re-upsert (which would reset the auto-dismiss timer).
  useTransitionEffect(`${flow?.phase ?? ''}:${flow?.signature ?? ''}`, () => {
    if (!flow) {
      return
    }
    const id = `tx-${kind}-${flow.signature}`
    if (flow.phase === 'delivered') {
      upsertToast({
        id,
        kind: 'success',
        title: kind === 'deposit' ? 'ONyc credited' : 'USDC.s credited',
        href: fogoTxUrl(flow.signature),
      })
    } else if (flow.phase === 'expired') {
      upsertToast({
        id,
        kind: 'error',
        title: 'Bridge still pending after 30 min',
        description: 'Check Wormholescan for the in-flight VAA.',
        href: wormholeTxUrl(flow.signature),
      })
    }
  })

  const parsed = parseAmount(input, ui.inputDecimals, ui.inputSymbol)
  const submitting = status.kind === 'pending'
  // Deposit fee_mint = USDC.s, so the user's USDC.s balance funds both
  // `amount` and `fee` from the same ATA — fold the fee into the gate.
  // For withdraw, no bridge fee applies (fee in withdraw is deducted
  // Solana-side from the redemption output), so the fee component is
  // 0 there.
  const totalRequired
    = parsed.value !== null
      ? parsed.value + (kind === 'deposit' ? (bridgeFee.feeRaw ?? 0n) : 0n)
      : null
  const insufficient
    = totalRequired !== null
      && sourceBalance !== null
      && totalRequired > sourceBalance
  const ready
    = sessionEstablished
      && ui.ready
      && parsed.value !== null
      && parsed.value > 0n
      && !insufficient

  const onSubmit = async () => {
    if (!ready || parsed.value === null) {
      return
    }
    await submit(parsed.value)
  }

  const onMax = () => {
    if (sourceBalance !== null && sourceBalance > 0n) {
      setInput(formatAmount(sourceBalance, ui.inputDecimals))
    }
  }

  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-950 p-6 flex flex-col gap-4">
      {ui.unavailable
        ? <UnavailableState title={ui.unavailable.title} description={ui.unavailable.description} />
        : (
            <>
              <div className="relative flex flex-col gap-1.5">
                <AmountInput
                  label="You pay"
                  value={input}
                  onChange={setInput}
                  symbol={ui.inputSymbol}
                  decimals={ui.inputDecimals}
                  disabled={submitting || !sessionEstablished}
                  balance={sessionEstablished ? sourceBalance : undefined}
                  onMax={onMax}
                  parseError={parsed.error}
                />
                <DownConnector />
                <Receive
                  kind={kind}
                  parsed={parsed.value}
                  outputSymbol={ui.outputSymbol}
                  outputDecimals={ui.outputDecimals}
                  protocol={protocol}
                />
              </div>
              {kind === 'deposit' && (
                <BridgeFeeRow fee={bridgeFee} />
              )}
              <button
                type="button"
                onClick={onSubmit}
                disabled={!ready || submitting}
                className="w-full rounded-xl bg-neutral-100 py-3 text-sm font-semibold text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
              >
                {submitting
                  ? ui.submittingLabel
                  : insufficient
                    ? ui.insufficientLabel
                    : ui.submitLabel}
              </button>
            </>
          )}
    </section>
  )
}

/**
 * Small chip that overlays the gap between the pay and receive fields,
 * making the swap direction visually explicit. Absolutely positioned so
 * the two fields stay vertically flush against it without affecting
 * their layout.
 */
function DownConnector() {
  return (
    <div className="pointer-events-none relative h-0">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-950 text-neutral-400">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
        </div>
      </div>
    </div>
  )
}

/**
 * Pre-submit display of the deposit bridge fee. The fee is paid in
 * USDC.s (same token as the bridged amount) — intent_transfer pulls
 * `amount + fee` from the user's USDC.s ATA in a single SPL transfer.
 * The number comes from the on-chain `FeeConfig.bridge_transfer_fee`
 * for USDC.s — see `useBridgeFee`. Native-FOGO gas is sponsored by
 * Fogo Labs' generic `sessions` paymaster, so we don't surface a
 * FOGO-balance line here.
 */
function BridgeFeeRow({ fee }: {
  fee: ReturnType<typeof useBridgeFee>
}) {
  const display = fee.feeRaw === null
    ? '—'
    : `${formatAmount(fee.feeRaw, fee.feeDecimals)} ${fee.feeSymbol}`
  return (
    <div className="flex items-center justify-between rounded-lg border border-neutral-800/60 bg-neutral-900/40 px-3 py-2 text-xs">
      <span className="text-neutral-400">Bridge fee</span>
      <span className={fee.error ? 'text-amber-500/80' : 'text-neutral-200'}>
        {fee.error ? 'unavailable' : display}
      </span>
    </div>
  )
}

function UnavailableState({ title, description }: { title: string, description: string }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-800 bg-neutral-900/40 px-6 py-10 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-400">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-neutral-200">{title}</p>
        <p className="text-xs text-neutral-500">{description}</p>
      </div>
    </div>
  )
}

interface ReceiveProps {
  kind: TransferKind
  parsed: bigint | null
  outputSymbol: string
  outputDecimals: number
  protocol: ReturnType<typeof useProtocolState>
}

/**
 * Read-only "you receive" field plus a single fee/notice line beneath.
 * Replaces the old three-row quote breakdown — the swap-style two-field
 * layout is the dominant pattern for this kind of UI and the per-step
 * (gross / fee / net) breakdown was more detail than most users wanted.
 */
function Receive({ kind, parsed, outputSymbol, outputDecimals, protocol }: ReceiveProps) {
  const haveAmount = parsed !== null && parsed > 0n
  const depositQuote = haveAmount && protocol && kind === 'deposit'
    ? safeQuoteDeposit({
        inputUsdc: parsed,
        depositFeeBps: protocol.depositFeeBps,
        price: protocol.price,
        onycPrice: protocol.onycPrice,
      })
    : null
  const withdrawQuote = haveAmount && protocol && kind === 'withdraw'
    ? safeQuoteWithdraw({
        inputFogoOnyc: parsed,
        withdrawFeeBps: protocol.withdrawFeeBps,
        price: protocol.price,
        onycPrice: protocol.onycPrice,
      })
    : null

  const outputAmount = kind === 'deposit'
    ? depositQuote?.outputFogoOnyc ?? null
    : withdrawQuote?.outputUsdc ?? null
  const haveQuote = outputAmount !== null

  return (
    <div className="flex flex-col gap-1.5">
      <ReceiveField
        label="You receive"
        amount={outputAmount}
        symbol={outputSymbol}
        decimals={outputDecimals}
        preview={protocol?.priceIsPreview === true && haveQuote}
      />
      {protocol?.priceIsPreview && haveQuote && (
        <p className="text-[10px] text-amber-500/80">
          Quote uses a preview ONyc price (
          {protocol.priceFetchError ? `live read failed: ${protocol.priceFetchError}` : 'live price loading…'}
          ).
        </p>
      )}
    </div>
  )
}
