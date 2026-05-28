'use client'

import { ChevronDown, HelpCircle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

/**
 * Collapsible FAQ. Lives at the bottom of the detail page on purpose —
 * the user reads the hero/timeline first to learn *what's happening*,
 * and only scrolls here when they have a *question*.
 *
 * UX: the entire FAQ collapses behind a single top-level toggle by
 * default (Peak-End Rule — happy-path users see a tight, scannable
 * page end, not a wall of FAQ text). Inside, each question is its own
 * collapsible row. Chevron rotation is CSS-only via Tailwind's `open:`
 * variant against `<details[open]>` — no React state needed.
 *
 * Vocabulary is deliberately user-words, not jargon — no "VAA",
 * "guardian", "cranker", or "oracle" leaks out to the user.
 */
export function Help() {
  return (
    <Card>
      <CardContent className="px-5 py-2">
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors group-hover:text-foreground group-open:text-foreground">
              <HelpCircle aria-hidden className="size-4" />
              Common questions
            </span>
            <ChevronDown
              aria-hidden
              className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="mt-3 flex flex-col">
            <FaqItem
              question="What's happening to my transaction?"
              answer={(
                <>
                  <p>Your funds take three steps to cross between FOGO and Solana:</p>
                  <ol className="mt-2 ml-4 list-decimal space-y-1">
                    <li>FOGO accepts your transaction and locks your tokens.</li>
                    <li>Solana mirrors the action — swapping USDC for ONyc on a deposit, or redeeming ONyc for USDC on a withdrawal.</li>
                    <li>The result is delivered back to your FOGO wallet.</li>
                  </ol>
                  <p className="mt-2">
                    The timeline above shows the current step. Your funds stay on-chain the whole time — no third party ever holds them.
                  </p>
                </>
              )}
            />
            <FaqItem
              question="Why does it take a few minutes?"
              answer={(
                <>
                  <p>
                    Each leg of the bridge needs Wormhole&apos;s validator network to observe and sign the cross-chain message before it can be delivered. Typical times:
                  </p>
                  <ul className="mt-2 ml-4 list-disc space-y-1">
                    <li>
                      <strong>Deposit:</strong>
                      {' '}
                      2–4 minutes.
                    </li>
                    <li>
                      <strong>Redeem:</strong>
                      {' '}
                      5–10 minutes — sometimes longer when OnRe is filling redemptions slowly.
                    </li>
                  </ul>
                  <p className="mt-2">
                    If it runs past the usual window, the card above flags it as &ldquo;taking longer than usual&rdquo;.
                  </p>
                </>
              )}
            />
            <FaqItem
              question="What if it never arrives?"
              answer={(
                <>
                  <p>Stalled bridges are rare and recoverable. Two cases:</p>
                  <ul className="mt-2 ml-4 list-disc space-y-1">
                    <li>
                      <strong>Your funds already arrived</strong>
                      {' '}
                      but the page didn&apos;t notice — use &ldquo;Mark as delivered&rdquo; in Actions. That only updates how this row looks on your device; on-chain state is unchanged.
                    </li>
                    <li>
                      <strong>The bridge truly stalled</strong>
                      {' '}
                      — use &ldquo;Report a problem&rdquo; to open an issue with your transaction signature. We&apos;ll look into it.
                    </li>
                  </ul>
                  <p className="mt-2">
                    Either way your funds aren&apos;t lost. The bridge has no custodial step — your value sits in audited on-chain programs the entire flight.
                  </p>
                </>
              )}
            />
            <FaqItem
              question="Can I cancel a bridge in progress?"
              answer={(
                <p>
                  No. Once submitted, the bridge runs to completion on its own. In rare cases the protocol team can reverse a redemption — that returns your ONyc instead of delivering USDC — but cancellation isn&apos;t something you can trigger yourself.
                </p>
              )}
            />
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

function FaqItem({ question, answer }: { question: string, answer: React.ReactNode }) {
  return (
    <details className="group/item border-b border-border/60 py-3 last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground group-open/item:text-foreground [&::-webkit-details-marker]:hidden">
        <span>{question}</span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open/item:rotate-180"
        />
      </summary>
      <div className="mt-2 text-sm text-muted-foreground">
        {answer}
      </div>
    </details>
  )
}
