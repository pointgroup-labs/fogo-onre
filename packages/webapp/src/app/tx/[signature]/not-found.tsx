import Link from 'next/link'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

/**
 * 404 for the per-tx route. Reached when `notFound()` is called from
 * a server component, or when Next falls back here for an unmatched
 * dynamic segment. The runtime "not in your history" empty state lives
 * in `page.tsx` because it depends on client-side history fetch state.
 */
export default function TxNotFound() {
  return (
    <Alert>
      <AlertTitle>Page not found</AlertTitle>
      <AlertDescription>
        <p>The transaction you&apos;re looking for doesn&apos;t exist.</p>
        <Link href="/" className="mt-2 inline-block text-sm underline">Back to dashboard</Link>
      </AlertDescription>
    </Alert>
  )
}
