import { cn } from '@/lib/utils'

interface Props {
  label: string
  value: string
  hint?: string
  /**
   * Treat the value as not-yet-real: render the same muted "—"
   * placeholder used for genuinely-unknown values, instead of the
   * fallback number itself. Keeps NAV consistent with how APY and
   * TVL render while their inputs are still loading.
   */
  preview?: boolean
  className?: string
}

export default function Statistic({ label, value, hint, preview, className }: Props) {
  const display = preview ? '—' : value
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums',
          display === '—' && 'text-muted-foreground',
        )}
      >
        {display}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}
