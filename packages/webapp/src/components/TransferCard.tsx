'use client'

import type { FlowKind } from '@/lib/flow-status/types'
import type { TransferFormValues } from '@/lib/forms/transfer-schema'
import { isEstablished, useSession } from '@fogo/sessions-sdk-react'
import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useForm } from 'react-hook-form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
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
      srcSymbol: 'USDC.s',
      destSymbol: 'ONyc',
      srcDecimals: USDC_DECIMALS,
      destDecimals: FOGO_ONYC_DECIMALS,
      submitLabel: 'Deposit',
      submittingLabel: 'Depositing…',
      insufficientLabel: 'Insufficient USDC.s',
      ready: true,
      unavailable: null,
    }
  }
  return {
    srcMintB58: FOGO_ONYC_MINT.toBase58(),
    destMintB58: USDC_S_MINT.toBase58(),
    srcSymbol: 'ONyc',
    destSymbol: 'USDC.s',
    srcDecimals: FOGO_ONYC_DECIMALS,
    destDecimals: USDC_DECIMALS,
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
    submit.mutate({
      kind,
      amountStr: values.amount,
      decimals: ui.srcDecimals,
      mintB58: ui.srcMintB58,
      destOwnerB58: sessionState.walletPublicKey.toBase58(),
      destMintB58: ui.destMintB58,
    })
    form.reset({ amount: '' })
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
      <CardHeader>
        <CardTitle>{ui.submitLabel}</CardTitle>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center justify-between">
                    <FormLabel>You pay</FormLabel>
                    <button
                      type="button"
                      onClick={onMax}
                      disabled={!sessionEstablished || maxRaw === 0n}
                      className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      Max:
                      {' '}
                      {maxAmountStr}
                    </button>
                  </div>
                  <FormControl>
                    <div className="relative">
                      <Input
                        inputMode="decimal"
                        placeholder="0.0"
                        disabled={submitting || !sessionEstablished}
                        {...field}
                      />
                      <Badge
                        variant="secondary"
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                      >
                        {ui.srcSymbol}
                      </Badge>
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DownConnector />

            <Receive
              kind={kind}
              parsed={parsed.value}
              destSymbol={ui.destSymbol}
              destDecimals={ui.destDecimals}
              protocol={protocol}
            />

            {kind === 'deposit' && <BridgeFeeRow fee={bridgeFee} />}

            <Button type="submit" size="lg" disabled={submitDisabled}>
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
    <div className="pointer-events-none relative h-0">
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg border bg-background text-muted-foreground">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="19 12 12 19 5 12" />
          </svg>
        </div>
      </div>
    </div>
  )
}

function BridgeFeeRow({ fee }: { fee: ReturnType<typeof useBridgeFee> }) {
  const display = fee.feeRaw === null
    ? '—'
    : `${formatAmount(fee.feeRaw, fee.feeDecimals)} ${fee.feeSymbol}`
  return (
    <div className="flex items-center justify-between rounded-md border px-3 py-2 text-xs">
      <span className="text-muted-foreground">Bridge fee</span>
      <span className={fee.error ? 'text-amber-500/80' : ''}>
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
  protocol: ReturnType<typeof useProtocolState>
}

function Receive({ kind, parsed, destSymbol, destDecimals, protocol }: ReceiveProps) {
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

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">You receive</span>
        </div>
        <div className="relative flex items-center rounded-md border bg-muted/30 px-3 py-2">
          <span className={`flex-1 text-sm ${haveQuote ? '' : 'text-muted-foreground'}`}>
            {display}
          </span>
          <Badge variant="secondary">{destSymbol}</Badge>
        </div>
      </div>
      {protocol.priceIsPreview && haveQuote && (
        <p className="text-[10px] text-amber-500/80">
          Quote uses a preview ONyc price (
          {protocol.priceFetchError ? `live read failed: ${protocol.priceFetchError}` : 'live price loading…'}
          ).
        </p>
      )}
    </div>
  )
}
