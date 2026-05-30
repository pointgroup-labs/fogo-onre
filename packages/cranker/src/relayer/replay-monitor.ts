import type { PublicKey } from '@solana/web3.js'
import type { Metrics } from '../metrics'
import type { Logger } from '../utils/log'
import { findIntentTransferSetterPda, INTENT_TRANSFER_PROGRAM_ID } from '@fogo-onre/sdk'

// Derived once: the setter PDA of the *dormant* program (Fogo). After the
// hard cutover OnRe is the active program, so a legitimate flow's NTT
// sender is the OnRe setter. A sender equal to this PDA means the intent
// was routed through Fogo's program instead — the cross-program replay
// signal Open Q5 calls out. The relayer's {OnRe,Fogo} allowlist still
// accepts it (deliberate switch-back affordance), so flagging is purely
// observational.
const DORMANT_SETTER = findIntentTransferSetterPda(INTENT_TRANSFER_PROGRAM_ID)[0]

/**
 * Observational replay monitor. If an inbound VAA's NTT sender is the
 * dormant intent program's setter PDA, bump
 * `cranker_intent_replay_observed_total{leg}` and warn. Returns whether a
 * replay was flagged. Never alters flow — it only surfaces a signal an
 * operator alert can fire on.
 */
export function flagDormantSetterReplay(args: {
  senderOnSource: PublicKey
  leg: 'deposit' | 'withdraw'
  metrics: Pick<Metrics, 'intentReplayObserved'>
  log: Logger
}): boolean {
  if (!args.senderOnSource.equals(DORMANT_SETTER)) {
    return false
  }
  args.metrics.intentReplayObserved.inc({ leg: args.leg })
  args.log.warn('inbound VAA sender is the dormant intent setter — possible cross-program replay', {
    leg: args.leg,
    sender: args.senderOnSource.toBase58(),
    dormantSetter: DORMANT_SETTER.toBase58(),
  })
  return true
}
