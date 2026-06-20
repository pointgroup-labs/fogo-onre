/**
 * Timeout refund driver: for a stale `Received` flow, NTT-send the original
 * received token back to `flow.recipient` and close the flow. The on-chain
 * status/timeout guards and flow close prevent double-spends.
 *
 * LIVE-INTEGRATION: the transfer_lock + release_wormhole_outbound CPI hits
 * Wormhole Core, which LiteSVM can't host. The on-chain guards are covered by
 * `tests/refund.test.ts`; this driver's RPC path needs a devnet rig.
 */
import type { AdvanceContext, AdvanceResult } from './types'
import {
  describeStatus,
  findAuthorityPda,
  findNttPeerPda,
  findRegisteredTransceiverPda,
  findSessionAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  nttTransferArgsHash,
  REFUND_TIMEOUT_SLOTS,
  resolveNttVaa,
} from '@fogo-onre/sdk'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { makePriorityFeeIx } from '../utils/priority-fee'
import { DEFAULT_NTT_VERSION, fetchVaaBytes, WORMHOLE_CORE_MAINNET } from '../utils/wormhole'
import { fetchFlowFor } from './flow-fetch'
import { isLostRace } from './race-classifier'
import { deriveReleaseAccounts } from './send'

// NTT charges OutboxItem rent (~1,858,320 lamports) from `relayer_authority`
// via invoke_signed; target debit + rent-exempt + headroom = 3M.
const RELAYER_AUTH_TOPUP = 3_000_000n
// session_authority is signer-only; 2M leaves it well above rent-exempt.
const SESSION_AUTH_TOPUP = 2_000_000n

/** Pure timeout gate: a `Received` flow is refundable once this many slots pass. */
export function refundDue(receivedSlot: bigint, currentSlot: bigint): boolean {
  return currentSlot >= receivedSlot + REFUND_TIMEOUT_SLOTS
}

export type RefundInput = {
  direction: 'deposit' | 'withdraw'
  fogoTx: string
  vaaHex?: string
  nttVersion?: string
  wormholeCore?: string
}

/**
 * Refund leg is permissionless and profit-neutral: on-chain `rent_destination`
 * is pinned to `flow.payer`, so a third-party caller can't skim rent. This
 * off-by-default cranker driver is the intended path.
 */
export async function refund(
  ctx: AdvanceContext,
  input: RefundInput,
): Promise<AdvanceResult> {
  const { connection, keypair, client, metrics } = ctx
  const isDeposit = input.direction === 'deposit'

  try {
    // Fetch the pair config first so NTT managers come from it, not constants.
    const cfg = await client.fetchConfig()
    const nttBaseProgram = cfg.nttBaseProgram as PublicKey
    const nttAssetProgram = cfg.nttAssetProgram as PublicKey
    // Refund returns the original received token: deposit→base, withdraw→asset.
    const inboundNttProgram = isDeposit ? nttBaseProgram : nttAssetProgram
    const originalManager = inboundNttProgram
    const originalMint = (isDeposit ? cfg.baseMint : cfg.assetMint) as PublicKey

    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: inboundNttProgram })

    const flow = await fetchFlowFor(client, input.direction, resolved.nttInboxItem)
    if (!flow) {
      return { kind: 'noop', reason: `no Flow for inbox-item ${resolved.nttInboxItem.toBase58()}` }
    }
    const flowStatus = describeStatus(flow.status)
    if (flowStatus !== 'Received') {
      return { kind: 'noop', reason: `Flow status is ${flowStatus}, expected Received` }
    }

    const currentSlot = BigInt(await connection.getSlot('confirmed'))
    const receivedSlot = BigInt(flow.receivedSlot.toString())
    if (!refundDue(receivedSlot, currentSlot)) {
      return {
        kind: 'noop',
        reason: `flow received_slot ${receivedSlot} + timeout ${REFUND_TIMEOUT_SLOTS} not yet reached (slot ${currentSlot})`,
      }
    }

    if (nttAssetProgram.equals(nttBaseProgram)) {
      return {
        kind: 'noop',
        severity: 'config',
        reason: 'asset NTT manager not deployed (cfg.nttAssetProgram == cfg.nttBaseProgram placeholder)',
      }
    }

    // FOGO peer + registered_transceiver must exist on the original-token
    // manager, the only per-destination-chain accounts the send-back needs.
    const [fogoPeerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, originalManager)
    const peerInfo = await connection.getAccountInfo(fogoPeerPda).catch(() => null)
    if (!peerInfo) {
      return { kind: 'noop', severity: 'config', reason: `FOGO peer not registered on original-token NTT manager (${fogoPeerPda.toBase58()})` }
    }
    const [registeredTransceiverPda] = findRegisteredTransceiverPda(originalManager, originalManager)
    const transceiverInfo = await connection.getAccountInfo(registeredTransceiverPda).catch(() => null)
    if (!transceiverInfo) {
      return { kind: 'noop', severity: 'config', reason: `registered_transceiver PDA not initialized on original-token NTT manager (${registeredTransceiverPda.toBase58()})` }
    }

    const flowRecipient = flow.recipient.toBytes()
    const flowAmount = BigInt(flow.amount.toString())
    const outboxItem = Keypair.generate()

    const argsHash = nttTransferArgsHash({
      amount: flowAmount,
      recipientChain: FOGO_WORMHOLE_CHAIN_ID,
      recipientAddress: flowRecipient,
      shouldQueue: false,
    })
    const [relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    const [sessionAuthorityPda] = findSessionAuthorityPda(relayerAuthorityPda, argsHash, originalManager)
    const [relayerAuthInfo, sessionAuthInfo] = await Promise.all([
      connection.getAccountInfo(relayerAuthorityPda).catch(() => null),
      connection.getAccountInfo(sessionAuthorityPda).catch(() => null),
    ])
    const computeTopUp = (existing: number | undefined, target: bigint): bigint => {
      const e = BigInt(existing ?? 0)
      return e >= target ? 0n : target - e
    }
    const fundIxs: ReturnType<typeof SystemProgram.transfer>[] = []
    const relayerTopUp = computeTopUp(relayerAuthInfo?.lamports, RELAYER_AUTH_TOPUP)
    const sessionTopUp = computeTopUp(sessionAuthInfo?.lamports, SESSION_AUTH_TOPUP)
    if (relayerTopUp > 0n) {
      fundIxs.push(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: relayerAuthorityPda, lamports: Number(relayerTopUp) }))
    }
    if (sessionTopUp > 0n) {
      fundIxs.push(SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: sessionAuthorityPda, lamports: Number(sessionTopUp) }))
    }

    const release = await deriveReleaseAccounts(
      connection,
      originalMint,
      originalManager,
      input.wormholeCore ?? WORMHOLE_CORE_MAINNET,
      input.nttVersion ?? DEFAULT_NTT_VERSION,
      keypair.publicKey,
      outboxItem.publicKey,
    )

    const refundIx = await client
      .refund({
        payer: keypair.publicKey,
        direction: isDeposit ? { deposit: {} } : { withdraw: {} },
        baseMint: cfg.baseMint as PublicKey,
        assetMint: cfg.assetMint as PublicKey,
        // Route the SDK through the config's managers, not its OnRe defaults.
        nttBaseProgram: cfg.nttBaseProgram as PublicKey,
        nttAssetProgram: cfg.nttAssetProgram as PublicKey,
        nttInboxItem: resolved.nttInboxItem,
        // On-chain `address = flow.payer` close constraint.
        rentDestination: flow.payer as PublicKey,
        flowAmount,
        flowRecipient,
        outboxItem: outboxItem.publicKey,
        release,
      })
      .instruction()

    // transfer_lock + release_wormhole_outbound + the Flow close overflow the
    // legacy 1232-byte limit; the send-leg LUT is mandatory (same as `send`).
    if (!ctx.sendLookupTable) {
      return {
        kind: 'noop',
        severity: 'config',
        reason: 'SEND_LOOKUP_TABLE not configured — refund tx exceeds the 1232-byte limit without the send-leg LUT',
      }
    }
    const lut = await connection.getAddressLookupTable(ctx.sendLookupTable)
    if (!lut.value) {
      throw new Error(`refund AddressLookupTable ${ctx.sendLookupTable.toBase58()} not found`)
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [makePriorityFeeIx(ctx.priorityFeeMicroLamports), ...fundIxs, refundIx],
    }).compileToV0Message([lut.value])
    const vtx = new VersionedTransaction(messageV0)
    const sig = await ctx.provider.sendAndConfirm(vtx, [outboxItem], {
      commitment: 'confirmed',
      skipPreflight: false,
    })

    metrics.txSent.inc({ instruction: 'refund', result: 'ok' })
    metrics.flowAdvance.inc({ leg: input.direction, from_status: 'Received', to_status: 'Closed' })
    return { kind: 'advanced', signatures: [sig], fromStatus: 'Received', toStatus: 'Closed' }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'refund', result: 'error' })
    const raceReason = isLostRace(err)
    if (raceReason) {
      return { kind: 'noop', reason: raceReason }
    }
    return {
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      partialSignatures: [],
    }
  }
}
