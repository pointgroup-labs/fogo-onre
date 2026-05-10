import type { Logger } from '../utils/log'
import type { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NTT_ONYC_PROGRAM_ID, ONYC_MINT, WH_TRANSCEIVER_ONYC_PROGRAM_ID } from '@fogo-onre/sdk'
import {
  ComputeBudgetProgram,
  Keypair as Web3Keypair,
  sendAndConfirmTransaction,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { deserialize } from '@wormhole-foundation/sdk-definitions'
import { register as registerNttDefinitions } from '@wormhole-foundation/sdk-definitions-ntt'
import { register as registerSolanaNtt, SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import { withTimeout } from '../utils/rpc'

registerNttDefinitions()
registerSolanaNtt()

const NETWORK = 'Mainnet' as const
const SOLANA_CHAIN = 'Solana' as const
const SOLANA_WORMHOLE_CORE = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'
const NTT_VERSION = '3.0.0'

type SolanaOnycNtt = SolanaNtt<typeof NETWORK, typeof SOLANA_CHAIN>
// `redeem(attestations[])` accepts a union including
// `Ntt:WormholeTransferStandardRelayer`; only `Ntt:WormholeTransfer` is
// relevant for our use case (the relayer-relayer path is unused here).
// Narrow by intersection to the transfer flavour.
type WormholeTransferVaa = Extract<
  Parameters<SolanaOnycNtt['redeem']>[0][number],
  { payloadName: 'WormholeTransfer' }
>

let cachedNtt: SolanaOnycNtt | null = null

function getOrCreateOnycNtt(connection: Connection): SolanaOnycNtt {
  if (cachedNtt) {
    return cachedNtt
  }
  cachedNtt = new SolanaNtt(
    NETWORK,
    SOLANA_CHAIN,
    connection,
    {
      coreBridge: SOLANA_WORMHOLE_CORE,
      ntt: {
        manager: NTT_ONYC_PROGRAM_ID.toBase58(),
        token: ONYC_MINT.toBase58(),
        transceiver: { wormhole: WH_TRANSCEIVER_ONYC_PROGRAM_ID.toBase58() },
      },
    },
    NTT_VERSION,
  )
  return cachedNtt
}

export type PrepareTransceiverMessageInput = {
  connection: Connection
  payer: Keypair
  vaaBytes: Uint8Array
  /**
   * The expected `transceiver_message` PDA for this VAA, as already
   * derived by `resolveNttVaa`. Used as the idempotency probe target —
   * if this account is already owned by the ONyc NTT manager, prep was
   * done by an earlier scan tick (or another cranker) and we skip.
   */
  transceiverMessagePda: PublicKey
  rpcTimeoutMs: number
  txConfirmTimeoutMs: number
  log: Logger
}

export type PrepareTransceiverMessageResult =
  | { kind: 'already-prepared' }
  | { kind: 'prepared', signatures: string[] }
  | { kind: 'error', error: Error }

/**
 * Pre-step for `unlock_onyc`: ensures the ONyc NTT
 * `transceiver_message` PDA exists on Solana, owned by the ONyc NTT
 * manager program. The on-chain `unlock_onyc` handler declares this
 * account with `owner = NTT_ONYC_PROGRAM_ID` and *cannot* create it
 * itself — its CPI does `redeem` + `release_inbound_unlock`, which both
 * read the existing transceiver_message.
 *
 * **Why this exists at all:** the Wormhole generic-relayer that auto-
 * posts inbound VAAs is (as of 2026-05) only subscribed to the USDC.s
 * NTT manager, not the ONyc manager. Without this pre-step, every
 * inbound ONyc VAA permanently fails `unlock_onyc` at Anchor's
 * `ConstraintOwner (2004)` check (`Left=11111…, Right=nttpna5…`).
 *
 * **What it does NOT do:** it does NOT call `redeem` or
 * `release_inbound_unlock`. Both of those are done by the on-chain
 * `unlock_onyc` handler under the relayer-PDA signer, and a standalone
 * redeem here would (a) consume the inbox-item PDA, causing the
 * subsequent on-chain redeem to fail with `init`-constraint violation,
 * and (b) move tokens to the wrong recipient. We extract only the
 * `post_vaa + receive_message` half of the SolanaNtt SDK's bundled
 * pipeline.
 *
 * **Idempotency:** probe the transceiver_message PDA first. If it
 * already exists, return `already-prepared` without spending gas.
 * Concurrent crankers will see this state once any one of them lands
 * the post+receive sequence.
 *
 * **SDK extraction strategy:** mirror the structure of
 * `SolanaNtt#redeem` (sdk-solana-ntt/dist/.../sdk/ntt.js:782) up to
 * but excluding the `[redeemIx, releaseIx]` instructions that the SDK
 * appends to its `Ntt.Redeem` versioned-tx atom. We use the SDK's
 * public surface: `getWormholeTransceiver`, `whTransceiver.createReceiveIx`,
 * `whTransceiver.verifyVaaShim.methods`, and `core.postVaa`. When the
 * SDK upgrades, this function is the single chase point.
 */
export async function prepareTransceiverMessage(
  input: PrepareTransceiverMessageInput,
): Promise<PrepareTransceiverMessageResult> {
  const { connection, payer, vaaBytes, transceiverMessagePda, rpcTimeoutMs, txConfirmTimeoutMs, log } = input

  // Idempotency probe: if the PDA already exists owned by the NTT
  // manager, we're done. Note: a System-owned account at the same
  // address (lamports==0, data empty) means uninitialized — fall
  // through to prep.
  const existing = await withTimeout(
    connection.getAccountInfo(transceiverMessagePda),
    rpcTimeoutMs,
    'getAccountInfo(transceiverMessage)',
  ).catch(() => null)
  if (existing && existing.owner.equals(NTT_ONYC_PROGRAM_ID)) {
    log.debug('transceiver_message already prepared', {
      pda: transceiverMessagePda.toBase58(),
    })
    return { kind: 'already-prepared' }
  }

  let vaa: WormholeTransferVaa
  try {
    vaa = deserialize('Ntt:WormholeTransfer', vaaBytes) as WormholeTransferVaa
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }

  const ntt = getOrCreateOnycNtt(connection)
  let whTransceiver: Awaited<ReturnType<SolanaOnycNtt['getWormholeTransceiver']>>
  try {
    whTransceiver = await ntt.getWormholeTransceiver()
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }
  if (!whTransceiver) {
    return { kind: 'error', error: new Error('ONyc NTT manager has no wormhole transceiver registered') }
  }

  const senderAddress = payer.publicKey
  const signatures: string[] = []

  try {
    if (whTransceiver.verifyVaaShim) {
      // Shim mode: two txs.
      //   tx1: postSignatures (writes guardian sigs to ephemeral account)
      //   tx2: receive_wormhole_message_instruction_data + closeSignatures
      const signatureKeypair = Web3Keypair.generate()

      const wormholeNTT = vaa
      const sigsArg = wormholeNTT.signatures.map((s) => [
        s.guardianIndex,
        ...Array.from(s.signature.encode()),
      ])

      const postSigsIx = await whTransceiver.verifyVaaShim.methods
        .postSignatures(wormholeNTT.guardianSet, wormholeNTT.signatures.length, sigsArg)
        .accounts({
          payer: senderAddress,
          guardianSignatures: signatureKeypair.publicKey,
        })
        .instruction()

      const tx1 = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        postSigsIx,
      )
      tx1.feePayer = senderAddress
      const sig1 = await withTimeout(
        sendAndConfirmTransaction(
          connection,
          tx1,
          [payer, signatureKeypair],
          { commitment: 'confirmed', skipPreflight: false },
        ),
        txConfirmTimeoutMs,
        'sendAndConfirmTransaction(VerifyVAAShim.PostSignature)',
      )
      signatures.push(sig1)
      log.info('posted guardian signatures', { signature: sig1, signatureKeypair: signatureKeypair.publicKey.toBase58() })

      const useMessageAccount = false
      const receiveIx = await whTransceiver.createReceiveIx(
        wormholeNTT,
        senderAddress,
        signatureKeypair.publicKey,
        useMessageAccount,
      )
      const closeSigsIx = await whTransceiver.verifyVaaShim.methods
        .closeSignatures()
        .accounts({
          guardianSignatures: signatureKeypair.publicKey,
          refundRecipient: senderAddress,
        })
        .instruction()

      const blockhash = await connection.getLatestBlockhash('confirmed')
      const messageV0 = new TransactionMessage({
        payerKey: senderAddress,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          receiveIx,
          closeSigsIx,
        ],
        recentBlockhash: blockhash.blockhash,
      }).compileToV0Message()
      const vtx = new VersionedTransaction(messageV0)
      vtx.sign([payer])
      const sig2 = await withTimeout(
        connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false }),
        txConfirmTimeoutMs,
        'sendRawTransaction(receive+closeSignatures)',
      )
      await withTimeout(
        connection.confirmTransaction(
          { signature: sig2, blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
          'confirmed',
        ),
        txConfirmTimeoutMs,
        'confirmTransaction(receive+closeSignatures)',
      )
      signatures.push(sig2)
      log.info('received transceiver message (shim)', { signature: sig2, transceiverMessage: transceiverMessagePda.toBase58() })
    } else {
      // Non-shim mode: iterate core.postVaa generator (verify_signatures
      // + post_vaa, possibly several txs for large VAAs), then build
      // and send a single receive_message tx.
      for await (const unsigned of ntt.core.postVaa(senderAddress, vaa)) {
        const stx = unsigned.transaction
        const inner = stx.transaction
        const extraSigners = stx.signers ?? []
        let sig: string
        if (inner instanceof VersionedTransaction) {
          inner.sign([payer, ...extraSigners])
          sig = await withTimeout(
            connection.sendRawTransaction(inner.serialize(), { skipPreflight: false }),
            txConfirmTimeoutMs,
            'sendRawTransaction(core.postVaa step)',
          )
          const bh = await connection.getLatestBlockhash('confirmed')
          await withTimeout(
            connection.confirmTransaction(
              { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
              'confirmed',
            ),
            txConfirmTimeoutMs,
            'confirmTransaction(core.postVaa step)',
          )
        } else {
          const legacy = inner as Transaction
          sig = await withTimeout(
            sendAndConfirmTransaction(
              connection,
              legacy,
              [payer, ...extraSigners],
              { commitment: 'confirmed', skipPreflight: false },
            ),
            txConfirmTimeoutMs,
            'sendAndConfirmTransaction(core.postVaa step)',
          )
        }
        signatures.push(sig)
        log.info('posted VAA step (non-shim)', { signature: sig, description: unsigned.description })
      }

      const receiveIx = await whTransceiver.createReceiveIx(vaa, senderAddress)
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        receiveIx,
      )
      tx.feePayer = senderAddress
      const sig = await withTimeout(
        sendAndConfirmTransaction(
          connection,
          tx,
          [payer],
          { commitment: 'confirmed', skipPreflight: false },
        ),
        txConfirmTimeoutMs,
        'sendAndConfirmTransaction(receive_message)',
      )
      signatures.push(sig)
      log.info('received transceiver message (non-shim)', { signature: sig, transceiverMessage: transceiverMessagePda.toBase58() })
    }
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }

  return { kind: 'prepared', signatures }
}
