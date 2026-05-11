'use client'

import type { ReactNode, Ref } from 'react'
import type { FlowKind } from '@/lib/flow-status/types'
import type { TransferFormValues } from '@/lib/forms/transfer-schema'
import { isEstablished, useSession } from '@fogo/sessions-sdk-react'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowDown, Loader2 } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import SymbolPill from '@/components/SymbolPill'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Form, FormField, FormItem } from '@/components/ui/form'
import {
  FOGO_ONYC_DECIMALS,
  FOGO_ONYC_DEPLOYMENT_READY,
  FOGO_ONYC_MINT,
  USDC_DECIMALS,
  USDC_S_MINT,
} from '@/constants'
import { useBalances } from '@/hooks/useBalances'
import { useBridgeFee } from '@/hooks/useBridgeFee'
import { useProtocolState } from '@/hooks/useProtocolState'
import { useTransferMutation } from '@/hooks/useTransferMutation'
import { createDepositBridgeContextProvider } from '@/lib/bridge/depositContext'
import { makeTransferSchema } from '@/lib/forms/transfer-schema'
import { safeQuoteDeposit, safeQuoteWithdraw } from '@/utils/quote'
import { formatAmount, parseAmount } from '@/utils/transfer'

interface TransferCardProps {
  kind: FlowKind
}

interface KindConfig {
  srcMintB58: string
  destMintB58: string
  srcSymbol: string
  destSymbol: string
  srcDecimals: number
  destDecimals: number
  submitLabel: string
  submittingLabel: string
  insufficientLabel: string
  ready: boolean
  unavailable: { title: string, description: string } | null
}

function configFor(kind: FlowKind): KindConfig {
  if (kind === 'deposit') {
    return {
      srcMintB58: USDC_S_MINT.toBase58(),
      destMintB58: FOGO_ONYC_MINT.toBase58(),
      srcSymbol: 'USDC',
      destSymbol: 'ONyc',
      srcDecimals: USDC_DECIMALS,
      destDecimals: FOGO_ONYC_DECIMALS,
      submitLabel: 'Deposit',
      submittingLabel: 'Depositing…',
      insufficientLabel: 'Insufficient USDC',
      ready: true,
      unavailable: null,
    }
  }
  return {
    srcMintB58: FOGO_ONYC_MINT.toBase58(),
    destMintB58: USDC_S_MINT.toBase58(),
    srcSymbol: 'ONyc',
    destSymbol: 'USDC',
    srcDecimals: FOGO_ONYC_DECIMALS,
    destDecimals: USDC_DECIMALS,
    submitLabel: 'Redeem',
    submittingLabel: 'Redeeming…',
    insufficientLabel: 'Insufficient ONyc',
    ready: FOGO_ONYC_DEPLOYMENT_READY,
    unavailable: FOGO_ONYC_DEPLOYMENT_READY
      ? null
      : {
          title: 'Redemptions coming soon',
          description: 'The FOGO-side ONyc bridge isn\'t live yet. Deposits work today; you\'ll be able to redeem here once it ships.',
        },
  }
}

export default function TransferCard({ kind }: TransferCardProps) {
  const ui = configFor(kind)
  const sessionState = useSession()
  const sessionEstablished = isEstablished(sessionState)
  const { snapshot: balances } = useBalances(sessionState)
  const protocol = useProtocolState()
  const bridgeFee = useBridgeFee()

  // Deposit: fee_mint = USDC.s, intent_transfer pulls `amount + fee`
  // from the same ATA, so the schema's max must net out the fee. For
  // withdraw the fee is deducted Solana-side, so 0 there.
  const sourceBalance = kind === 'deposit' ? balances.usdc : balances.fogoOnyc
  const destBalance = kind === 'deposit' ? balances.fogoOnyc : balances.usdc
  const balanceLoading = sessionEstablished && sourceBalance === null
  const destBalanceLoading = sessionEstablished && destBalance === null
  const feeForGate = kind === 'deposit' ? (bridgeFee.feeRaw ?? 0n) : 0n
  const maxRaw = sourceBalance !== null
    ? (sourceBalance > feeForGate ? sourceBalance - feeForGate : 0n)
    : 0n
  const maxAmountStr = formatAmount(maxRaw, ui.srcDecimals)

  const resolver = useMemo(
    () => zodResolver(makeTransferSchema({ maxAmountStr, decimals: ui.srcDecimals })),
    [maxAmountStr, ui.srcDecimals],
  )
  const form = useForm<TransferFormValues>({
    resolver,
    mode: 'onChange',
    defaultValues: { amount: '' },
  })

  // Re-validate when the resolver swaps (balance / fee tick) so a stale
  // "valid" state can't survive a balance drop.
  useEffect(() => {
    if (form.getValues('amount') !== '') {
      void form.trigger('amount')
    }
  }, [maxAmountStr, ui.srcDecimals, form])

  const bridgeContextProvider = useMemo(
    () => kind === 'deposit' ? createDepositBridgeContextProvider() : null,
    [kind],
  )
  const submit = useTransferMutation({ bridgeContextProvider })

  const amountInput = form.watch('amount')
  const parsed = parseAmount(amountInput, ui.srcDecimals, ui.srcSymbol)
  const totalRequired = parsed.value !== null
    ? parsed.value + feeForGate
    : null
  const insufficient
    = totalRequired !== null
      && sourceBalance !== null
      && totalRequired > sourceBalance

  function onSubmit(values: TransferFormValues) {
    if (!sessionEstablished) {
      return
    }
    submit.mutate(
      {
        kind,
        amountStr: values.amount,
        decimals: ui.srcDecimals,
        mintB58: ui.srcMintB58,
        destOwnerB58: sessionState.walletPublicKey.toBase58(),
        destMintB58: ui.destMintB58,
      },
      {
        // Only clear the field once the bridge has actually been
        // submitted on-chain. Resetting eagerly inside the click
        // handler discards the user's input on wallet rejection,
        // network error, or any pre-flight validation failure.
        onSuccess: () => {
          form.reset({ amount: '' })
        },
      },
    )
  }

  function onMax() {
    if (maxRaw > 0n) {
      form.setValue('amount', maxAmountStr, { shouldValidate: true, shouldDirty: true })
    }
  }

  if (ui.unavailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{ui.submitLabel}</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertTitle>{ui.unavailable.title}</AlertTitle>
            <AlertDescription>{ui.unavailable.description}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    )
  }

  const submitting = submit.isPending
  const submitDisabled
    = !form.formState.isValid
      || submitting
      || !sessionEstablished
      || !ui.ready
      || insufficient
      || (kind === 'deposit' && bridgeFee.error !== null)

  const buttonLabel = submitting
    ? ui.submittingLabel
    : insufficient
      ? ui.insufficientLabel
      : ui.submitLabel

  return (
    <Card>
      <CardContent className="pt-1">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-5">
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem className="space-y-0">
                  <AmountPanel
                    label="You pay"
                    symbol={ui.srcSymbol}
                    placeholder="0.0"
                    disabled={submitting || !sessionEstablished}
                    field={field}
                    balanceChip={(
                      <BalanceChip
                        sessionEstablished={sessionEstablished}
                        loading={balanceLoading}
                        maxAmountStr={maxAmountStr}
                        maxRaw={maxRaw}
                        onMax={onMax}
                      />
                    )}
                  />
                </FormItem>
              )}
            />

            <DownConnector />

            <Receive
              kind={kind}
              parsed={parsed.value}
              destSymbol={ui.destSymbol}
              destDecimals={ui.destDecimals}
              destBalance={destBalance}
              destLoading={destBalanceLoading}
              sessionEstablished={sessionEstablished}
              protocol={protocol}
            />

            {kind === 'deposit' && (
              <div className="-mt-1">
                <BridgeFeeRow fee={bridgeFee} />
              </div>
            )}

            <Button type="submit" size="lg" className="h-12 text-base" disabled={submitDisabled}>
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {buttonLabel}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function DownConnector() {
  return (
    <div className="pointer-events-none relative z-10 -my-3 flex h-0 items-center justify-center">
      <div
        className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-sm"
      >
        <ArrowDown className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
      </div>
    </div>
  )
}

function BridgeFeeRow({ fee }: { fee: ReturnType<typeof useBridgeFee> }) {
  const display = fee.feeRaw === null
    ? '—'
    : `${formatAmount(fee.feeRaw, fee.feeDecimals)} ${fee.feeSymbol}`
  return (
    <div className="flex items-center justify-between px-1 text-xs">
      <span className="text-muted-foreground">Fee</span>
      <span className={fee.error ? 'text-amber-500/80' : 'text-foreground/80 tabular-nums'}>
        {fee.error ? 'unavailable' : display}
      </span>
    </div>
  )
}

interface ReceiveProps {
  kind: FlowKind
  parsed: bigint | null
  destSymbol: string
  destDecimals: number
  destBalance: bigint | null
  destLoading: boolean
  sessionEstablished: boolean
  protocol: ReturnType<typeof useProtocolState>
}

function Receive({
  kind,
  parsed,
  destSymbol,
  destDecimals,
  destBalance,
  destLoading,
  sessionEstablished,
  protocol,
}: ReceiveProps) {
  const haveAmount = parsed !== null && parsed > 0n
  const depositQuote = haveAmount && kind === 'deposit'
    ? safeQuoteDeposit({
        inputUsdc: parsed,
        depositFeeBps: protocol.depositFeeBps,
        price: protocol.price,
        onycPrice: protocol.onycPrice,
      })
    : null
  const withdrawQuote = haveAmount && kind === 'withdraw'
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
  const display = haveQuote ? formatAmount(outputAmount!, destDecimals) : '—'
  const destBalanceStr = destBalance !== null ? formatAmount(destBalance, destDecimals) : '0'

  return (
    <div className="flex flex-col gap-1.5">
      <div className="rounded-xl border border-border bg-card/60 px-4 py-3.5">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>You receive</span>
          <DestBalanceReadout
            sessionEstablished={sessionEstablished}
            loading={destLoading}
            amountStr={destBalanceStr}
          />
        </div>
        <div className="mt-2 flex items-center gap-3">
          <span
            className={`min-w-0 flex-1 truncate text-2xl font-medium tracking-tight tabular-nums ${
              haveQuote
                ? protocol.priceIsPreview ? 'text-amber-300' : 'text-foreground'
                : 'text-muted-foreground/60'
            }`}
          >
            {display}
          </span>
          <SymbolPill symbol={destSymbol} />
        </div>
      </div>
      {protocol.priceIsPreview && haveQuote && (
        <p className="px-1 text-[10px] text-amber-500/80">
          Quote uses a preview ONyc price (
          {protocol.priceFetchError ? `live read failed: ${protocol.priceFetchError}` : 'live price loading…'}
          ).
        </p>
      )}
    </div>
  )
}

interface AmountPanelProps {
  label: string
  symbol: string
  placeholder: string
  disabled: boolean
  field: {
    value: string
    onChange: (...args: unknown[]) => void
    onBlur: (...args: unknown[]) => void
    name: string
    ref: Ref<HTMLInputElement>
  }
  balanceChip: ReactNode
}

function AmountPanel({ label, symbol, placeholder, disabled, field, balanceChip }: AmountPanelProps) {
  return (
    <div
      className="rounded-xl border border-border bg-card/60 px-4 py-3.5 transition-colors focus-within:border-foreground/40"
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="shrink-0">{balanceChip}</span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <input
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          disabled={disabled}
          className="min-w-0 flex-1 bg-transparent text-2xl font-medium tracking-tight tabular-nums outline-none placeholder:text-muted-foreground/40 disabled:opacity-50"
          {...field}
        />
        <SymbolPill symbol={symbol} />
      </div>
    </div>
  )
}

interface BalanceChipProps {
  sessionEstablished: boolean
  loading: boolean
  maxAmountStr: string
  maxRaw: bigint
  onMax: () => void
}

function BalanceChip({ sessionEstablished, loading, maxAmountStr, maxRaw, onMax }: BalanceChipProps) {
  const interactive = sessionEstablished && !loading && maxRaw > 0n
  const numberSlot = !sessionEstablished
    ? '—'
    : loading
      ? <span className="inline-block h-3 w-12 animate-pulse rounded bg-muted-foreground/20 align-middle" />
      : maxAmountStr
  return (
    <button
      type="button"
      onClick={onMax}
      disabled={!interactive}
      aria-label={interactive ? `Set max ${maxAmountStr}` : undefined}
      className="inline-flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 transition-colors hover:border-border hover:text-foreground disabled:cursor-default disabled:opacity-70 disabled:hover:border-transparent disabled:hover:text-muted-foreground"
    >
      <WalletIcon />
      <span className="tabular-nums">{numberSlot}</span>
      {interactive && (
        <span className="font-semibold uppercase tracking-wide text-[10px] text-foreground/70">Max</span>
      )}
    </button>
  )
}

function WalletIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h16v4" />
      <path d="M21 12v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7" />
      <circle cx="17" cy="14" r="1" />
    </svg>
  )
}

interface DestBalanceReadoutProps {
  sessionEstablished: boolean
  loading: boolean
  amountStr: string
}

function DestBalanceReadout({ sessionEstablished, loading, amountStr }: DestBalanceReadoutProps) {
  return (
    <span className="inline-flex items-center gap-1.5 px-1.5 py-0.5">
      <WalletIcon />
      <span className="tabular-nums">
        {!sessionEstablished
          ? '—'
          : loading
            ? <span className="inline-block h-3 w-12 animate-pulse rounded bg-muted-foreground/20 align-middle" />
            : amountStr}
      </span>
    </span>
  )
}
