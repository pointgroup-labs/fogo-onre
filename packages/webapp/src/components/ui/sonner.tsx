'use client'

import type { ToasterProps } from 'sonner'
import { CircleCheckIcon, InfoIcon, Loader2Icon, OctagonXIcon, TriangleAlertIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Toaster as Sonner } from 'sonner'

function Toaster({ ...props }: ToasterProps) {
  const { theme = 'system' } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps['theme']}
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
          // Sonner's default action button is a muted grey set via
          // inline styles, which on our popover-bg toasts blends in to
          // the point of looking disabled. Overriding with a filled
          // inverse-of-surface treatment (foreground bg / background
          // text) gives the action a primary-button feel in both
          // themes and on every toast variant — emerald would clash on
          // error toasts, red would clash on success. The `!` important
          // variants are required to beat Sonner's inline styles.
          actionButton:
            '!bg-foreground !text-background hover:!bg-foreground/90 !rounded-md !px-3 !py-1 !text-xs !font-medium !transition-colors',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
