'use client'

interface AmountInputProps {
  value: string
  onChange: (next: string) => void
  symbol: string
  disabled?: boolean
  onMax?: () => void
}

export default function AmountInput({ value, onChange, symbol, disabled, onMax }: AmountInputProps) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 focus-within:border-neutral-500">
      <input
        type="text"
        inputMode="decimal"
        placeholder="0.0"
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="flex-1 bg-transparent text-lg outline-none placeholder:text-neutral-600 disabled:opacity-50"
      />
      {onMax && (
        <button
          type="button"
          onClick={onMax}
          disabled={disabled}
          className="text-xs uppercase tracking-wide text-neutral-400 hover:text-neutral-100 disabled:opacity-50"
        >
          Max
        </button>
      )}
      <span className="text-sm font-medium text-neutral-400">{symbol}</span>
    </div>
  )
}
