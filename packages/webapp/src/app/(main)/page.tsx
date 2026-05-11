import ErrorBoundary from '@/components/ErrorBoundary'
import TransferCard from '@/components/TransferCard'

// `/` — deposit. The surrounding shell (header, tabs, history) lives in
// the `(main)/layout.tsx` route group; this file is just the inner slot.
export default function DepositPage() {
  return (
    <ErrorBoundary label="deposit">
      <TransferCard kind="deposit" />
    </ErrorBoundary>
  )
}
