import type { FlowKind, FlowStatusValue } from '@/lib/flow-status/types'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const DEPOSIT_STEPS = ['Burn USDC.s', 'Claim', 'Swap', 'Mint ONyc'] as const
const WITHDRAW_STEPS = ['Burn ONyc', 'Unlock', 'Redeem', 'Receive USDC.s'] as const

interface Props {
  kind: FlowKind
  status: FlowStatusValue
  /**
   * Optional 0-indexed override. When omitted, the index is derived from
   * `status`. `-1` means "nothing started yet" (rendered as all-dim).
   *
   * Reserved for a future world where the relayer surfaces per-instruction
   * progress (e.g. via a finer FlowStatus PDA shape). Today no caller passes it.
   */
  currentIndex?: number
}

export default function BridgeSteps({ kind, status, currentIndex }: Props) {
  const steps = kind === 'deposit' ? DEPOSIT_STEPS : WITHDRAW_STEPS
  const idx = currentIndex ?? deriveIndex(status, steps.length)
  const failed = status === 'terminal-failure'

  return (
    <ol className="flex items-center gap-2" aria-label={`${kind} progress`}>
      {steps.map((label, i) => {
        const isFailedStep = failed && i === idx
        const isDoneStep = !failed && i <= idx
        const isPendingStep = !isFailedStep && !isDoneStep
        return (
          <li key={label} className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border text-[10px]',
                isDoneStep && 'border-primary bg-primary text-primary-foreground',
                isFailedStep && 'border-destructive bg-destructive text-destructive-foreground',
                isPendingStep && 'border-muted-foreground/40 text-muted-foreground',
              )}
              aria-current={i === idx ? 'step' : undefined}
            >
              {isFailedStep ? <X className="h-3 w-3" /> : isDoneStep ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span
              className={cn(
                isDoneStep && 'text-foreground',
                isFailedStep && 'text-destructive',
                isPendingStep && 'text-muted-foreground',
              )}
            >
              {label}
            </span>
            {i < steps.length - 1 && <span className="h-px w-3 bg-muted-foreground/30" aria-hidden="true" />}
          </li>
        )
      })}
    </ol>
  )
}

function deriveIndex(status: FlowStatusValue, total: number): number {
  if (status === 'pending') {
    return 0
  }
  if (status === 'in-progress') {
    return Math.floor(total / 2)
  }
  if (status === 'terminal-success') {
    return total - 1
  }
  // terminal-failure: freeze at in-progress position so the failed step is highlighted.
  return Math.floor(total / 2)
}
