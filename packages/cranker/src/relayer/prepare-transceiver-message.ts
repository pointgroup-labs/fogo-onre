import type { Connection, Keypair, PublicKey } from '@solana/web3.js'
import type { Logger } from '../utils/log'
import {
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  Keypair as Web3Keypair,
} from '@solana/web3.js'
import { deserialize } from '@wormhole-foundation/sdk-definitions'
import { register as registerNttDefinitions } from '@wormhole-foundation/sdk-definitions-ntt'
import { register as registerSolanaNtt, SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import { isVersionedTransaction, makePriorityFeeIx } from '../utils/priority-fee'
import { withTimeout } from '../utils/rpc'

registerNttDefinitions()
registerSolanaNtt()

const NETWORK = 'Mainnet' as const
const SOLANA_CHAIN = 'Solana' as const
const SOLANA_WORMHOLE_CORE = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'
const NTT_VERSION = '3.0.0'

type SolanaNttMainnet = SolanaNtt<typeof NETWORK, typeof SOLANA_CHAIN>
// `redeem(attestations[])` accepts a union including
// `Ntt:WormholeTransferStandardRelayer`; only `Ntt:WormholeTransfer` is
// relevant for our use case (the relayer-relayer path is unused here).
// Narrow by intersection to the transfer flavour.
type WormholeTransferVaa = Extract<
  Parameters<SolanaNttMainnet['redeem']>[0][number],
  { payloadName: 'WormholeTransfer' }
>

// One SolanaNtt instance per (manager, connection) tuple. Constructing
// the SDK object resolves an IDL fetch internally on first use, so the
// cache amortises that across scan ticks. Keyed on the manager pubkey
// because all other fields (token, transceiver) are functionally
// determined by it for our deploys (bundled mode → transceiver==manager).
const nttCache = new Map<string, SolanaNttMainnet>()

function getOrCreateNtt(
  connection: Connection,
  manager: PublicKey,
  token: PublicKey,
  transceiver: PublicKey,
): SolanaNttMainnet {
  const key = manager.toBase58()
  const cached = nttCache.get(key)
  if (cached) {
    return cached
  }
  const ntt = new SolanaNtt(
    NETWORK,
    SOLANA_CHAIN,
    connection,
    {
      coreBridge: SOLANA_WORMHOLE_CORE,
      ntt: {
        manager: key,
        token: token.toBase58(),
        transceiver: { wormhole: transceiver.toBase58() },
      },
    },
    NTT_VERSION,
  )
  nttCache.set(key, ntt)
  return ntt
}

export type PrepareTransceiverMessageInput = {
  connection: Connection
  payer: Keypair
  vaaBytes: Uint8Array
  /**
   * The expected `transceiver_message` PDA for this VAA, as already
   * derived by `resolveNttVaa`. Used as the idempotency probe target —
   * if this account is already owned by `expectedOwner`, prep was done
   * by an earlier scan tick (or another cranker) and we skip.
   */
  transceiverMessagePda: PublicKey
  /**
   * NTT manager program ID for this leg (e.g. `NTT_USDC_PROGRAM_ID` or
   * `NTT_ONYC_PROGRAM_ID`). The SolanaNtt SDK object is keyed on this.
   */
  manager: PublicKey
  /** SPL mint the NTT manager custodies (`USDC_MINT` or `ONYC_MINT`). */
  token: PublicKey
  /**
   * Wormhole transceiver program. In bundled mode (current OnRe
   * deploy) this equals `manager`. Kept as a separate parameter for
   * forward-compatibility with standalone-transceiver NTT deploys.
   */
  transceiver: PublicKey
  /**
   * Program that should own the `transceiver_message` PDA once posted.
   * For bundled NTT this equals `manager`; the parameter is explicit
   * so the idempotency check stays correct under future standalone
   * deploys.
   */
  expectedOwner: PublicKey
  rpcTimeoutMs: number
  txConfirmTimeoutMs: number
  /** µ-lamports/CU prepended to every postVaa-sequence tx. */
  priorityFeeMicroLamports: number
  log: Logger
}

export type PrepareTransceiverMessageResult
  = | { kind: 'already-prepared' }
    | { kind: 'prepared', signatures: string[] }
    | { kind: 'error', error: Error }

/** Flatten an error's message + any attached program logs into searchable strings. */
function errorStrings(err: unknown): string[] {
  const out: string[] = []
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown, logs?: unknown, errorLogs?: unknown, transactionLogs?: unknown }
    if (typeof e.message === 'string') {
      out.push(e.message)
    }
    // web3.js surfaces program logs on `.logs`, `.errorLogs`, or
    // `.transactionLogs` depending on the error path — scan all three.
    for (const logs of [e.logs, e.errorLogs, e.transactionLogs]) {
      if (Array.isArray(logs)) {
        for (const l of logs) {
          if (typeof l === 'string') {
            out.push(l)
          }
        }
      }
    }
  } else if (typeof err === 'string') {
    out.push(err)
  }
  return out
}

/**
 * True when the failure is the System program refusing to `Allocate` the
 * transceiver_message PDA because it *already exists* — i.e. a concurrent
 * cranker, an earlier scan tick, or Wormhole's generic relayer posted it
 * after our idempotency probe but before our receive landed. Scoped to this
 * exact PDA so unrelated allocate failures still surface as real errors.
 */
function transceiverMessageAlreadyExists(err: unknown, pda: PublicKey): boolean {
  const pdaStr = pda.toBase58()
  return errorStrings(err).some(s => s.includes('already in use') && s.includes(pdaStr))
}

/**
 * Pre-step for any handler that consumes an NTT `transceiver_message`
 * PDA: ensures that PDA exists on Solana, owned by the corresponding
 * NTT manager program. The on-chain handlers (`unlock_onyc`,
 * `claim_usdc`) declare this account with `owner = <manager>` and
 * cannot* create it themselves — their CPIs do `redeem` +
 * `release_inbound_*`, which both read the existing transceiver_message.
 *
 * **Why this exists at all:** in practice the Wormhole generic-relayer
 * that auto-posts inbound VAAs is unreliable for our deploys — it has
 * been observed to skip both legs depending on subscription state.
 * Without this pre-step, inbound VAAs intermittently fail at Anchor's
 * `ConstraintOwner (2004)` check (`Left=11111…, Right=<manager>`).
 * Generic, manager-agnostic, idempotent — call it from any inbound
 * leg whose handler reads an NTT transceiver_message account.
 *
 * **What it does NOT do:** it does NOT call `redeem` or
 * `release_inbound_{mint,unlock}`. Both of those are done by the
 * on-chain handler under the relayer-PDA signer, and a standalone
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
  const {
    connection,
    payer,
    vaaBytes,
    transceiverMessagePda,
    manager,
    token,
    transceiver,
    expectedOwner,
    rpcTimeoutMs,
    txConfirmTimeoutMs,
    priorityFeeMicroLamports,
    log,
  } = input
  const priorityFeeIx = makePriorityFeeIx(priorityFeeMicroLamports)

  // Idempotency probe: if the PDA already exists owned by the expected
  // manager program, we're done. Note: a System-owned account at the
  // same address (lamports==0, data empty) means uninitialized — fall
  // through to prep.
  const existing = await withTimeout(
    connection.getAccountInfo(transceiverMessagePda),
    rpcTimeoutMs,
    'getAccountInfo(transceiverMessage)',
  ).catch(() => null)
  if (existing && existing.owner.equals(expectedOwner)) {
    log.debug('transceiver_message already prepared', {
      pda: transceiverMessagePda.toBase58(),
      manager: manager.toBase58(),
    })
    return { kind: 'already-prepared' }
  }

  let vaa: WormholeTransferVaa
  try {
    vaa = deserialize('Ntt:WormholeTransfer', vaaBytes) as WormholeTransferVaa
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }

  const ntt = getOrCreateNtt(connection, manager, token, transceiver)
  let whTransceiver: Awaited<ReturnType<SolanaNttMainnet['getWormholeTransceiver']>>
  try {
    whTransceiver = await ntt.getWormholeTransceiver()
  } catch (err) {
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }
  if (!whTransceiver) {
    return { kind: 'error', error: new Error(`NTT manager ${manager.toBase58()} has no wormhole transceiver registered`) }
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
      const sigsArg = wormholeNTT.signatures.map(s => [
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
        priorityFeeIx,
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
          priorityFeeIx,
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
        // **Do NOT inject our priority-fee ix into SDK-yielded postVaa
        // txs.** Wormhole core's `postVaa(...)` already embeds
        // compute-budget pricing (setComputeUnitPrice + setComputeUnitLimit)
        // into the txs it yields. Layering another setComputeUnitPrice on
        // top — even after filtering — produced DuplicateInstruction (0x2)
        // at simulation under pnpm's dual-realm @solana/web3.js resolution.
        // Same lesson as `bridge/sdk-redeem.ts`: when a third-party SDK
        // owns the tx, sign and send it as the SDK built it. Priority
        // fees still apply to every tx we construct ourselves elsewhere
        // in this function (shim mode tx1/tx2 and the non-shim final
        // receive_message tx below).
        //
        // Cross-realm-safe detection of v0 vs legacy because the SDK and
        // we may resolve different physical copies of @solana/web3.js
        // under pnpm — see `isVersionedTransaction` for the rationale.
        if (isVersionedTransaction(inner)) {
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
        priorityFeeIx,
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
    // Lost the create race: the PDA was posted between our probe and our
    // receive. The post-condition (PDA exists, owned by the manager) holds,
    // and derivation matches `client.receive`'s account — so treat it as
    // prepared and let the flow advance instead of erroring out forever.
    if (transceiverMessageAlreadyExists(err, transceiverMessagePda)) {
      log.debug('transceiver_message already exists (create race) — treating as prepared', {
        pda: transceiverMessagePda.toBase58(),
        manager: manager.toBase58(),
      })
      return { kind: 'already-prepared' }
    }
    return { kind: 'error', error: err instanceof Error ? err : new Error(String(err)) }
  }

  return { kind: 'prepared', signatures }
}
