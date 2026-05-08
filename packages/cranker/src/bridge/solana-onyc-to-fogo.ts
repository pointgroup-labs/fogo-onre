import type { NttManagerMode } from '@fogo-onre/sdk'
import type { Connection, Keypair } from '@solana/web3.js'
import type { BridgeRedeemTarget } from './types'
import {
  decodeNttConfig,
  findInboxRateLimitPda,
  findNttConfigPda,
  findNttEmitterPda,
  findNttPeerPda,
  findRegisteredTransceiverPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_ONYC_PROGRAM_ID,

  SOLANA_WORMHOLE_CHAIN_ID,
  WH_TRANSCEIVER_ONYC_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { PublicKey } from '@solana/web3.js'
import { withTimeout } from '../utils/rpc'

/** Default FOGO ONyc mint. Same address as webapp constants.ts. */
export const DEFAULT_FOGO_ONYC_MINT = new PublicKey('oNyCm1QsAatj3ckaEwZjtAPWvstPn3Zm5MAYPtkjEfa')

export interface SolanaOnycToFogoOptions {
  fogoConnection: Connection
  destSigner: Keypair
  /** Override the source emitter (defaults to PDA from `NTT_ONYC_PROGRAM_ID`). */
  solanaOnycEmitterHex?: string
  /** Override the FOGO-side ONyc NTT manager program id. */
  fogoOnycNttProgramId?: PublicKey
  /** Override the FOGO-side wormhole transceiver program id (defaults to `WH_TRANSCEIVER_ONYC_PROGRAM_ID`). */
  fogoOnycWhTransceiverProgramId?: PublicKey
  /** Override the FOGO ONyc mint. */
  fogoOnycMint?: PublicKey
  /** Override the expected manager mode (skip the on-chain probe). */
  expectedReleaseMode?: NttManagerMode
  rpcTimeoutMs?: number
}

/**
 * Build the single bridge target this codebase has today: outbound
 * Solana ONyc → FOGO ONyc redemption. The relayer's `lock_onyc.rs`
 * emits the VAA but doesn't pay an executor; this is the off-chain
 * consumer.
 *
 * Probes the FOGO ONyc manager's `Config` once at startup to determine
 * the release variant (`mint` for Burning, `unlock` for Locking) and
 * asserts it matches `expectedReleaseMode` if set. The mode is a
 * deploy-time invariant — flipping it requires NTT governance and a
 * full re-init, so a startup probe is sufficient and we don't re-probe
 * per VAA.
 */
export async function buildSolanaOnycToFogoTarget(
  opts: SolanaOnycToFogoOptions,
): Promise<BridgeRedeemTarget> {
  const programId = opts.fogoOnycNttProgramId ?? NTT_ONYC_PROGRAM_ID
  const whTransceiverProgramId = opts.fogoOnycWhTransceiverProgramId ?? WH_TRANSCEIVER_ONYC_PROGRAM_ID
  const mint = opts.fogoOnycMint ?? DEFAULT_FOGO_ONYC_MINT
  const sourceEmitterHex = opts.solanaOnycEmitterHex
    ?? Buffer.from(findNttEmitterPda(NTT_ONYC_PROGRAM_ID)[0].toBytes()).toString('hex')
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 15_000

  const [configPda] = findNttConfigPda(programId)
  const info = await withTimeout(
    opts.fogoConnection.getAccountInfo(configPda),
    rpcTimeoutMs,
    'fogo.getAccountInfo(NttConfig)',
  )
  if (!info) {
    throw new Error(
      `FOGO ONyc NTT manager Config PDA (${configPda.toBase58()}) not found — `
      + `manager program ${programId.toBase58()} is not initialized on FOGO. `
      + `Run NTT init on FOGO before starting the bridge pipeline.`,
    )
  }
  const config = decodeNttConfig(Buffer.from(info.data))
  if (!config.mint.equals(mint)) {
    throw new Error(
      `FOGO ONyc NTT manager Config.mint = ${config.mint.toBase58()} does not match `
      + `expected ONyc mint ${mint.toBase58()} — likely wrong program id or mint override.`,
    )
  }
  if (opts.expectedReleaseMode && config.mode !== opts.expectedReleaseMode) {
    throw new Error(
      `FOGO ONyc NTT manager Config.mode = ${config.mode} but expected ${opts.expectedReleaseMode}. `
      + `Operator override mismatched on-chain state; refusing to start.`,
    )
  }

  // Governance-readiness probe. NTT v3 `redeem` references three
  // PDAs that exist only after `set_peer` / `register_transceiver` /
  // `set_inbound_limit` have been called for the inbound source chain.
  // If any is empty the redeem aborts with `AccountDiscriminatorNotFound`
  // (0xbb9). We surface that here so the operator gets a precise
  // "missing governance call X" message at startup, and so the planner
  // can refuse to submit doomed txs (saves SOL + keeps `bridgeRedeemed`
  // metrics honest).
  //
  // `transceiver` pubkey: in **bundled-transceiver mode** (which OnRe
  // uses) the registered_transceiver PDA is keyed on the manager's own
  // program ID — the manager IS the transceiver. `WH_TRANSCEIVER_ONYC_
  // PROGRAM_ID` is aliased to `NTT_ONYC_PROGRAM_ID` for this reason; do
  // NOT pass the value of `deployment.json`'s
  // `transceivers.wormhole.address` here — that's the manager's emitter
  // PDA, not a program ID, and using it produces phantom PDAs that are
  // always empty.
  const [peerPda] = findNttPeerPda(SOLANA_WORMHOLE_CHAIN_ID, programId)
  const [xcvrPda] = findRegisteredTransceiverPda(whTransceiverProgramId, programId)
  const [rateLimitPda] = findInboxRateLimitPda(SOLANA_WORMHOLE_CHAIN_ID, programId)

  const probes = [
    { name: 'peer', remedy: `set_peer(chain=${SOLANA_WORMHOLE_CHAIN_ID}, …)`, pda: peerPda },
    { name: 'registered_transceiver', remedy: 'register_transceiver(…)', pda: xcvrPda },
    { name: 'inbox_rate_limit', remedy: `set_inbound_limit(chain=${SOLANA_WORMHOLE_CHAIN_ID}, …)`, pda: rateLimitPda },
  ] as const

  const probeResults = await Promise.all(probes.map(p =>
    withTimeout(
      opts.fogoConnection.getAccountInfo(p.pda),
      rpcTimeoutMs,
      `fogo.getAccountInfo(${p.name})`,
    ).then(info => ({ ...p, present: !!info })),
  ))
  const missing = probeResults.filter(r => !r.present)
  const configReady = missing.length === 0
  const configError = configReady
    ? undefined
    : `FOGO ONyc manager ${programId.toBase58()} is missing NTT-governance state for source chain `
      + `${SOLANA_WORMHOLE_CHAIN_ID}: ${missing.map(m => `${m.name} PDA ${m.pda.toBase58()} (run \`${m.remedy}\`)`).join('; ')}`

  return {
    name: 'solana-onyc-to-fogo',
    sourceChainId: SOLANA_WORMHOLE_CHAIN_ID,
    sourceEmitterHex,
    destChainId: FOGO_WORMHOLE_CHAIN_ID,
    destConnection: opts.fogoConnection,
    destNttManagerProgramId: programId,
    destWhTransceiverProgramId: whTransceiverProgramId,
    destMint: mint,
    destSigner: opts.destSigner,
    destReleaseMode: config.mode,
    configReady,
    configError,
  }
}
