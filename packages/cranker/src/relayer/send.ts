import type { Connection } from '@solana/web3.js'
import type { AdvanceContext, AdvanceResult } from './types'
import {
  describeStatus,
  findAuthorityPda,
  findNttPeerPda,
  findRegisteredTransceiverPda,
  findSessionAuthorityPda,
  FOGO_WORMHOLE_CHAIN_ID,
  NTT_ONYC_PROGRAM_ID,
  NTT_USDC_PROGRAM_ID,
  nttTransferArgsHash,
  resolveNttVaa,
} from '@fogo-onre/sdk'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import { makePriorityFeeIx } from '../utils/priority-fee'
import { DEFAULT_NTT_VERSION, fetchVaaBytes, WORMHOLE_CORE_MAINNET } from '../utils/wormhole'
import { fetchFlowFor } from './flow-fetch'
import { isLostRace } from './race-classifier'

// NTT charges OutboxItem rent (~1,858,320 lamports) from `relayer_authority`
// via invoke_signed; target debit + rent-exempt + headroom = 3M.
const RELAYER_AUTH_TOPUP = 3_000_000n
// session_authority is signer-only; 2M leaves it well above rent-exempt.
const SESSION_AUTH_TOPUP = 2_000_000n

export type SendInput = {
  direction: 'deposit' | 'withdraw'
  fogoTx: string
  vaaHex?: string
  nttVersion?: string
  wormholeCore?: string
}

/**
 * Terminal leg of either chain: NTT `transfer_lock` back to FOGO and close
 * the Flow PDA (rent → `flow.payer`). Deposit pushes the asset mint via the
 * ONyc NTT manager; withdraw pushes the base mint via the USDC NTT manager.
 * Merges the old `lockOnyc` and `sendUsdcToUser` handlers, branching on
 * `input.direction`. Advances `Swapped → Closed`.
 *
 * The inbox-item VAA is resolved under the *inbound* leg's NTT program (the
 * Flow PDA was keyed on it), while the outbound transfer_lock + release
 * accounts are built against the *outbound* manager + mint.
 */
export async function send(
  ctx: AdvanceContext,
  input: SendInput,
): Promise<AdvanceResult> {
  const { connection, keypair, client, metrics } = ctx
  const isDeposit = input.direction === 'deposit'
  const inboundNttProgram = isDeposit ? NTT_USDC_PROGRAM_ID : NTT_ONYC_PROGRAM_ID
  const outboundManager = isDeposit ? NTT_ONYC_PROGRAM_ID : NTT_USDC_PROGRAM_ID

  try {
    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: inboundNttProgram })

    const flow = await fetchFlowFor(client, input.direction, resolved.nttInboxItem)
    if (!flow) {
      return {
        kind: 'noop',
        reason: `no Flow for inbox-item ${resolved.nttInboxItem.toBase58()} — prior legs haven't run`,
      }
    }
    const flowStatus = describeStatus(flow.status)
    if (flowStatus !== 'Swapped') {
      return { kind: 'noop', reason: `Flow status is ${flowStatus}, expected Swapped` }
    }

    if (isDeposit && NTT_ONYC_PROGRAM_ID.equals(NTT_USDC_PROGRAM_ID)) {
      return {
        kind: 'noop',
        severity: 'config',
        reason: 'ONyc NTT manager not deployed (NTT_ONYC_PROGRAM_ID == NTT_USDC_PROGRAM_ID placeholder)',
      }
    }

    // FOGO peer must be registered on the outbound NTT manager — the only
    // per-destination-chain account `transfer_lock` requires.
    const [fogoPeerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, outboundManager)
    const peerInfo = await connection.getAccountInfo(fogoPeerPda).catch(() => null)
    if (!peerInfo) {
      return {
        kind: 'noop',
        ...(isDeposit ? { severity: 'config' as const } : {}),
        reason: `FOGO peer not registered on outbound NTT manager (${fogoPeerPda.toBase58()})`,
      }
    }

    // registered_transceiver PDA must exist; NTT v3 release_wormhole_outbound
    // reads it and Anchor's init constraint fails with AccountNotInitialized.
    const [registeredTransceiverPda] = findRegisteredTransceiverPda(outboundManager, outboundManager)
    const transceiverInfo = await connection.getAccountInfo(registeredTransceiverPda).catch(() => null)
    if (!transceiverInfo) {
      return {
        kind: 'noop',
        ...(isDeposit ? { severity: 'config' as const } : {}),
        reason: `registered_transceiver PDA not initialized on outbound NTT manager (${registeredTransceiverPda.toBase58()})`,
      }
    }

    const cfg = await client.fetchConfig()
    const outboundMint = (isDeposit ? cfg.assetMint : cfg.baseMint) as PublicKey

    const flowRecipient = flow.recipient.toBytes()
    const flowAmount = BigInt(flow.amount.toString())
    const outboxItem = Keypair.generate()

    // Lamport top-ups: NTT debits OutboxItem rent from relayer_authority via
    // invoke_signed; session_authority must exist on-chain to be a signer.
    const argsHash = nttTransferArgsHash({
      amount: flowAmount,
      recipientChain: FOGO_WORMHOLE_CHAIN_ID,
      recipientAddress: flowRecipient,
      shouldQueue: false,
    })
    const [relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    const [sessionAuthorityPda] = findSessionAuthorityPda(relayerAuthorityPda, argsHash, outboundManager)
    const [relayerAuthInfo, sessionAuthInfo] = await Promise.all([
      connection.getAccountInfo(relayerAuthorityPda).catch(() => null),
      connection.getAccountInfo(sessionAuthorityPda).catch(() => null),
    ])
    const computeTopUp = (existing: number | undefined, target: bigint): bigint => {
      const e = BigInt(existing ?? 0)
      return e >= target ? 0n : target - e
    }
    const relayerTopUp = computeTopUp(relayerAuthInfo?.lamports, RELAYER_AUTH_TOPUP)
    const sessionTopUp = computeTopUp(sessionAuthInfo?.lamports, SESSION_AUTH_TOPUP)
    const fundIxs: ReturnType<typeof SystemProgram.transfer>[] = []
    if (relayerTopUp > 0n) {
      fundIxs.push(SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: relayerAuthorityPda,
        lamports: Number(relayerTopUp),
      }))
    }
    if (sessionTopUp > 0n) {
      fundIxs.push(SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: sessionAuthorityPda,
        lamports: Number(sessionTopUp),
      }))
    }

    const release = await deriveReleaseAccounts(
      connection,
      outboundMint,
      outboundManager,
      input.wormholeCore ?? WORMHOLE_CORE_MAINNET,
      input.nttVersion ?? DEFAULT_NTT_VERSION,
      keypair.publicKey,
      outboxItem.publicKey,
    )

    const sendIx = await client
      .send({
        payer: keypair.publicKey,
        direction: isDeposit ? { deposit: {} } : { withdraw: {} },
        baseMint: cfg.baseMint as PublicKey,
        assetMint: cfg.assetMint as PublicKey,
        nttInboxItem: resolved.nttInboxItem,
        // On-chain `address = flow.payer` constraint — close-target MUST
        // equal the original receive payer, who may not be us.
        rentDestination: flow.payer as PublicKey,
        flowAmount,
        flowRecipient,
        outboxItem: outboxItem.publicKey,
        release,
      })
      .instruction()

    // transfer_lock + release_wormhole_outbound + the Flow close overflow the
    // legacy 1232-byte limit; the send-leg LUT is mandatory, not optional —
    // without it every send is structurally too large. Fail legibly rather
    // than emitting a cryptic "tx too large" each scan.
    if (!ctx.sendLookupTable) {
      return {
        kind: 'noop',
        severity: 'config',
        reason: 'SEND_LOOKUP_TABLE not configured — send tx exceeds the 1232-byte limit without the send-leg LUT; set SEND_LOOKUP_TABLE to the send-leg LUT address and restart',
      }
    }
    const lut = await connection.getAddressLookupTable(ctx.sendLookupTable)
    if (!lut.value) {
      throw new Error(`send AddressLookupTable ${ctx.sendLookupTable.toBase58()} not found`)
    }
    const altAccounts = [lut.value]

    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: blockhash,
      instructions: [makePriorityFeeIx(ctx.priorityFeeMicroLamports), ...fundIxs, sendIx],
    }).compileToV0Message(altAccounts)
    const vtx = new VersionedTransaction(messageV0)
    const sig = await ctx.provider.sendAndConfirm(vtx, [outboxItem], {
      commitment: 'confirmed',
      skipPreflight: false,
    })

    metrics.txSent.inc({ instruction: 'send', result: 'ok' })
    metrics.flowAdvance.inc({ leg: input.direction, from_status: 'Swapped', to_status: 'Closed' })

    return { kind: 'advanced', signatures: [sig], fromStatus: 'Swapped', toStatus: 'Closed' }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'send', result: 'error' })
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

/**
 * Ask the upstream NTT SDK to build the canonical
 * `release_wormhole_outbound` ix against `manager` + `mint`, then pull the
 * 7 PDA-derived accounts the on-chain `send` handler needs from positions
 * [4], [5], [6], [7], [8], [9], [14] of the resulting account list.
 */
async function deriveReleaseAccounts(
  connection: Connection,
  mint: PublicKey,
  manager: PublicKey,
  wormholeCore: string,
  nttVersion: string,
  payer: PublicKey,
  outboxItem: PublicKey,
): Promise<{
  wormholeProgram: PublicKey
  wormholeBridge: PublicKey
  wormholeFeeCollector: PublicKey
  wormholeSequence: PublicKey
  outboxItemSigner: PublicKey
  wormholeMessage: PublicKey
  emitter: PublicKey
}> {
  const ntt = new SolanaNtt(
    'Mainnet',
    'Solana',
    connection,
    {
      coreBridge: wormholeCore,
      ntt: {
        manager: manager.toBase58(),
        token: mint.toBase58(),
        transceiver: { wormhole: manager.toBase58() },
      },
    },
    nttVersion,
  )
  const xcvr = await ntt.getWormholeTransceiver()
  if (!xcvr) {
    throw new Error('SolanaNttWormholeTransceiver wiring failed.')
  }
  const releaseIx = await xcvr.createReleaseWormholeOutboundIx(payer, outboxItem, false)
  const k = releaseIx.keys
  return {
    wormholeMessage: k[4].pubkey,
    emitter: k[5].pubkey,
    wormholeBridge: k[6].pubkey,
    wormholeFeeCollector: k[7].pubkey,
    wormholeSequence: k[8].pubkey,
    wormholeProgram: k[9].pubkey,
    outboxItemSigner: k[14].pubkey,
  }
}
