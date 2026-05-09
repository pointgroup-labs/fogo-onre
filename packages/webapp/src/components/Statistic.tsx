import { cn } from '@/lib/utils'

interface Props {
  label: string
  value: string
  hint?: string
  /** Dim the value with amber tint to indicate placeholder/preview data. */
  preview?: boolean
  className?: string
}

export default function Statistic({ label, value, hint, preview, className }: Props) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-2xl font-semibold tabular-nums',
          value === '—' && 'text-muted-foreground',
          preview && value !== '—' && 'text-amber-400',
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  )
}
