/**
 * Build the NTT v3 `release_wormhole_outbound` instruction targeting the
 * FOGO Wormhole Core. Used to publish a staged `OutboxItem` after a
 * `transfer_burn` so the message becomes a guardian-attestable VAA.
 *
 * Why this exists: NTT v1 splits the outbound flow in two on-chain
 * steps. `transfer_burn` debits the user and *stages* an OutboxItem PDA
 * but does not call `wormhole_core::post_message`. A separate
 * `release_wormhole_outbound` ix reads the OutboxItem and posts the
 * message. Without it, the burn lands but no VAA is ever published.
 *
 * Deposit hides this split inside `intent_transfer.bridge_ntt_tokens`
 * (which CPIs both atomically). Withdraw uses raw `transfer_burn`
 * because `FeeConfig(ONyc)` isn't registered with intent_transfer yet,
 * so we must include the publish ix ourselves.
 *
 * Account ordering and writability follow the upstream NTT v3 IDL —
 * see `packages/sdk/src/builders/ntt.ts:355` (`buildNttReleaseWormhole-
 * OutboundAccountList`), which we reuse to avoid duplicating the
 * 15-entry table. The Wormhole Core PDAs use the well-known seeds
 * `["Bridge"]`, `["fee_collector"]`, `["Sequence", emitter]` — stable
 * across all WH-Core deployments.
 */
import {
  buildNttReleaseWormholeOutboundAccountList,
  findNttEmitterPda,
  ixDiscriminator,
} from '@fogo-onre/sdk'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { FOGO_ONYC_NTT_MANAGER_ID, FOGO_WORMHOLE_CORE_PROGRAM_ID } from '@/constants'

/** Anchor sighash, cached at module init. */
const RELEASE_DISCRIMINATOR = ixDiscriminator('release_wormhole_outbound')

/**
 * NTT v3 `outbox_item_signer` PDA seed — `["outbox_item_signer"]` under
 * the transceiver program ID. Confirmed against
 * `@wormhole-foundation/sdk-solana-ntt`'s `lib/ntt.js` (`derivePda(["outbox_item_signer"], programId)`).
 */
function findOutboxItemSignerPda(transceiverProgramId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('outbox_item_signer')],
    transceiverProgramId,
  )
  return pda
}

/** WH Core `Bridge` PDA — singleton config account. */
function findWormholeBridgePda(corePid: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('Bridge')], corePid)
  return pda
}

/** WH Core `fee_collector` PDA — destination for the per-message lamport fee. */
function findWormholeFeeCollectorPda(corePid: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('fee_collector')], corePid)
  return pda
}

/** WH Core `Sequence` PDA — per-emitter sequence tracker. */
function findWormholeSequencePda(corePid: PublicKey, emitter: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('Sequence'), emitter.toBuffer()],
    corePid,
  )
  return pda
}

export interface BuildFogoReleaseOnycOutboundParams {
  /** User wallet — pays the WH-Core message fee + tx fee, signs. */
  payer: PublicKey
  /** Same OutboxItem pubkey passed into the preceding `transfer_burn`. */
  outboxItem: PublicKey
}

/**
 * Build `release_wormhole_outbound` for the FOGO ONyc NTT manager.
 * Constants are hard-coded to ONyc / FOGO-WH-Core because the only
 * caller is the withdraw path. If we ever publish from the USDC.s
 * manager on FOGO (we don't today), generalize this to take the
 * manager + transceiver + core pids as params.
 *
 * Payload: 1 byte `revertOnDelay = false`, matching the deposit-side
 * default. Setting it true would cause `release_wormhole_outbound` to
 * revert if the OutboxItem is in a delayed-release state from a rate
 * limit; we never queue, so the difference is moot — `false` keeps
 * behavior aligned with `intent_transfer.bridge_ntt_tokens`.
 */
export function buildFogoReleaseOnycOutboundIx(
  params: BuildFogoReleaseOnycOutboundParams,
): TransactionInstruction {
  const manager = FOGO_ONYC_NTT_MANAGER_ID
  // Combined NTT build: the WH transceiver IS the manager program.
  const transceiver = manager
  const core = FOGO_WORMHOLE_CORE_PROGRAM_ID

  const [emitter] = findNttEmitterPda(transceiver)
  const wormholeBridge = findWormholeBridgePda(core)
  const wormholeFeeCollector = findWormholeFeeCollectorPda(core)
  const wormholeSequence = findWormholeSequencePda(core, emitter)
  const outboxItemSigner = findOutboxItemSignerPda(transceiver)

  const keys = buildNttReleaseWormholeOutboundAccountList({
    payer: params.payer,
    nttProgramId: manager,
    transceiverProgramId: transceiver,
    outboxItem: params.outboxItem,
    wormholeProgram: core,
    wormholeBridge,
    wormholeFeeCollector,
    wormholeSequence,
    outboxItemSigner,
  })

  // discriminator (8) + revertOnDelay (1)
  const data = Buffer.alloc(RELEASE_DISCRIMINATOR.length + 1)
  data.set(RELEASE_DISCRIMINATOR, 0)
  data.writeUInt8(0, RELEASE_DISCRIMINATOR.length) // revertOnDelay = false

  return new TransactionInstruction({ programId: transceiver, keys, data })
}
