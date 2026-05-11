import ErrorBoundary from '@/components/ErrorBoundary'
import TransferCard from '@/components/TransferCard'

// `/withdraw` — withdraw. The surrounding shell lives in the
// `(main)/layout.tsx` route group; this file is just the inner slot.
export default function WithdrawPage() {
  return (
    <ErrorBoundary label="withdraw">
      <TransferCard kind="withdraw" />
    </ErrorBoundary>
  )
}
