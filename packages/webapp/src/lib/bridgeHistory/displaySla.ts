/**
 * Age past which an in-flight bridge action with no live progress signal
 * is shown as "Unconfirmed" rather than asserting progress or success.
 *
 * A withdraw is `'delivered'` only when its return leg paired on the
 * Wormholescan page; an older, still-`pending` action means the indexer
 * never surfaced that leg — sometimes a cross-tx VAA it failed to tag
 * (delivered), sometimes a genuine non-delivery. We can't tell them
 * apart without extra RPC, so past this age both the history list and
 * the tx-detail hero drop the optimistic copy for a neutral
 * "Unconfirmed" state. Shared so the two surfaces never disagree.
 *
 * 2 hours is generous: deposit happy path is ~3 min, redeem ~10 min, and
 * the hero's slow-threshold (8/30 min) already covers "actually slow".
 */
export const UNCONFIRMED_AFTER_MS = 2 * 60 * 60_000
