/**
 * Classifier for "lost race" Anchor errors — situations where the on-chain
 * handler rejected our tx because another cranker (or another path) already
 * advanced the leg between our pre-flight and our submit. These are routine
 * concurrency outcomes, not operator-actionable failures: downgrade to
 * `noop` so the FSM doesn't burn cooldown on a flow that is already further
 * along the chain.
 *
 * The table is the single source of truth for which Anchor error codes
 * count as benign races; add new entries here when a new leg surfaces a
 * race-only error. Keep entries narrow — anything that *could* indicate
 * real misconfiguration should stay an error.
 */

const RACE_TABLE: Record<number, string> = {
  // Relayer InsufficientInboxBalance: claim_usdc raced against a prior
  // claim_usdc + swap_usdc_to_onyc cycle that drained user_inbox_ata.
  6026: 'lost race — another cranker drained user_inbox_ata before our claim_usdc landed (InsufficientInboxBalance, code 6026)',
}

type AnchorErrorShape = {
  code?: unknown
  error?: { errorCode?: { number?: unknown } }
}

/**
 * Returns the noop reason if the error is a recognised benign race;
 * `null` otherwise. Callers fold the reason into their `AdvanceResult`:
 *
 *     const race = isLostRace(err)
 *     if (race) return { kind: 'noop', reason: race }
 */
export function isLostRace(err: unknown): string | null {
  if (err === null || typeof err !== 'object') {
    return null
  }
  const e = err as AnchorErrorShape
  const code = typeof e.code === 'number'
    ? e.code
    : typeof e.error?.errorCode?.number === 'number'
      ? e.error.errorCode.number
      : undefined
  if (code === undefined) {
    return null
  }
  return RACE_TABLE[code] ?? null
}
