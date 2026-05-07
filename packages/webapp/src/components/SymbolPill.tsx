'use client'

import type { StaticImageData } from 'next/image'
import Image from 'next/image'
import onycIcon from '@/assets/tokens/onyc.png'
import usdcIcon from '@/assets/tokens/usdc.svg'

/**
 * Per-symbol artwork. Static imports so Next can hash + optimize each
 * file at build time and we don't pay an extra request per token icon.
 *
 * Project tokens (ONyc / ONyc / wONyc) all reuse the OnRe artwork —
 * they're the same underlying yield asset wrapped at different stages
 * of the bridge. USDC.s reuses Circle's USDC mark for the same reason
 * (s-suffix is the FOGO-side wrapped variant, not a different brand).
 */
const TOKENS: Record<string, StaticImageData> = {
  'USDC.s': usdcIcon,
  'USDC': usdcIcon,
  'ONyc': onycIcon,
  'ONyc': onycIcon,
  'wONyc': onycIcon,
}

interface TokenIconProps {
  symbol: string
  size?: number
}

export function TokenIcon({ symbol, size = 18 }: TokenIconProps) {
  const src = TOKENS[symbol]
  if (!src) {
    // Unknown token → neutral monogram chip so callers get something
    // legible instead of a broken image.
    return (
      <span
        aria-hidden="true"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-700 font-bold leading-none text-neutral-200"
      >
        {symbol.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      // Round the image so PNGs with square canvases render as token-style
      // discs alongside the SVG (which already ships with a circular path).
      className="shrink-0 rounded-full"
    />
  )
}

/**
 * Right-edge pill on amount fields. Token icon + symbol — keeps the
 * asset identity glanceable.
 */
export default function SymbolPill({ symbol }: { symbol: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/80 py-1 pl-1 pr-2.5 text-xs font-semibold text-neutral-100">
      <TokenIcon symbol={symbol} />
      {symbol}
    </span>
  )
}
