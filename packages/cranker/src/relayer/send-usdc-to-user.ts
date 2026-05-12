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
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'
import { makePriorityFeeIx } from '../utils/priority-fee'
import { withTimeout } from '../utils/rpc'
import { DEFAULT_NTT_VERSION, fetchVaaBytes, WORMHOLE_CORE_MAINNET } from '../utils/wormhole'
import { isLostRace } from './race-classifier'

export type SendUsdcToUserInput = {
  fogoTx: string
  vaaHex?: string
  usdcMint?: PublicKey
  nttProgram?: PublicKey
  nttVersion?: string
  wormholeCore?: string
}

// NTT charges OutboxItem rent (~1,858,320 lamports) from `relayer_authority`
// via invoke_signed; target debit + rent-exempt + headroom = 3M.
// Same constant as lockOnyc — keep in sync.
const RELAYER_AUTH_TOPUP = 3_000_000n
// session_authority is signer-only; 2M leaves it well above rent-exempt.
const SESSION_AUTH_TOPUP = 2_000_000n

/**
 * Step 4 (terminal) of the withdraw chain. Drives `send_usdc_to_user`
 * on Solana: locks USDC.s back to FOGO via NTT `transfer_lock`,
 * targeted at `flow.fogo_sender`, and closes the outflight Flow PDA
 * (rent → `flow.payer`). Status: `Swapped` → flow closed; surfaced as
 * `WithdrawSwapped` → `WithdrawClosed`.
 *
 * The previous step (`swap_onyc_to_usdc`) writes the net USDC into
 * `flow.amount` and flips status to `Swapped`, and that per-flow state
 * is the only ordering guarantee `send_usdc_to_user` needs.
 *
 * Sender material: `flow.fogo_sender` (32 bytes, parsed from the VAA's
 * VTM by `unlock_onyc`) is the destination on FOGO. We pass it through
 * to the SDK's `sendUsdcToUser` builder which feeds it into the NTT
 * `transfer_lock` args along with `flow.amount` (the NET USDC amount
 * delivered by the swap, set by `swap_onyc_to_usdc`).
 */
export async function sendUsdcToUser(
  ctx: AdvanceContext,
  input: SendUsdcToUserInput,
): Promise<AdvanceResult> {
  const { connection, keypair, client, metrics } = ctx
  const nttProgram = input.nttProgram ?? NTT_USDC_PROGRAM_ID

  try {
    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    // The outflight Flow is keyed on the ONyc-side VAA's inbox-item
    // (created by unlock_onyc), so `resolveNttVaa` here MUST use the
    // ONyc program ID to match. Same VAA the cranker has been carrying
    // through unlock → request → claim. The USDC NTT program ID is
    // only used below for the transfer_lock accounts the SDK assembles.
    const onycResolved = resolveNttVaa({ vaaBytes, nttProgramId: NTT_ONYC_PROGRAM_ID })

    // Pre-flight 1: outflight Flow must exist with status=Swapped.
    const flow = await client.fetchOutflightFlow(onycResolved.nttInboxItem).catch(() => null)
    if (!flow) {
      return {
        kind: 'noop',
        reason: `no outflight Flow for inbox-item ${onycResolved.nttInboxItem.toBase58()} — earlier withdraw legs haven't run`,
      }
    }
    const flowStatus = describeStatus(flow.status)
    if (flowStatus !== 'Swapped') {
      return {
        kind: 'noop',
        reason: `outflight Flow status is ${flowStatus}, expected Swapped (synthetic: WithdrawSwapped)`,
      }
    }

    // Pre-flight 2: USDC NTT manager FOGO peer must be registered.
    // Symmetric with `lockOnyc` for the ONyc manager. Without it the
    // outbound transfer_lock account constraints fail, never reaching
    // the handler body. USDC manager is in production today (depositors
    // already use it), so this should pass — but the gate is cheap and
    // saves a confusing failure if the peer is ever de-registered.
    const [fogoPeerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, nttProgram)
    const peerInfo = await withTimeout(
      connection.getAccountInfo(fogoPeerPda),
      ctx.rpcTimeoutMs,
      'getAccountInfo(usdcFogoPeer)',
    ).catch(() => null)
    if (!peerInfo) {
      return {
        kind: 'noop',
        reason: `FOGO peer not registered on USDC NTT manager (${fogoPeerPda.toBase58()})`,
      }
    }

    // Pre-flight 3: USDC NTT registered_transceiver PDA must exist.
    // NTT v3 `release_wormhole_outbound` reads it; missing PDA fails
    // with AccountNotInitialized. (Production-ready for USDC, but
    // mirror lockOnyc's defensive check.)
    const [registeredTransceiverPda] = findRegisteredTransceiverPda(nttProgram, nttProgram)
    const transceiverInfo = await withTimeout(
      connection.getAccountInfo(registeredTransceiverPda),
      ctx.rpcTimeoutMs,
      'getAccountInfo(usdcRegisteredTransceiver)',
    ).catch(() => null)
    if (!transceiverInfo) {
      return {
        kind: 'noop',
        reason: `registered_transceiver PDA not initialized on USDC NTT manager (${registeredTransceiverPda.toBase58()})`,
      }
    }

    const cfg = await client.fetchConfig()
    const usdcMint = input.usdcMint ?? (cfg.usdcMint as PublicKey)

    const flowFogoSender = Uint8Array.from(flow.fogoSender as ArrayLike<number>)
    const flowAmount = BigInt(flow.amount.toString())

    const outboxItem = Keypair.generate()

    // Lamport top-ups — same dance as lockOnyc. NTT debits OutboxItem
    // rent from relayer_authority via invoke_signed; session_authority
    // needs to exist on-chain to be a signer.
    const argsHash = nttTransferArgsHash({
      amount: flowAmount,
      recipientChain: FOGO_WORMHOLE_CHAIN_ID,
      recipientAddress: flowFogoSender,
      shouldQueue: false,
    })
    const [relayerAuthorityPda] = findAuthorityPda(client.program.programId)
    const [sessionAuthorityPda] = findSessionAuthorityPda(
      relayerAuthorityPda,
      argsHash,
      nttProgram,
    )
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

    const sig = await client
      .sendUsdcToUser({
        payer: keypair.publicKey,
        usdcMint,
        nttInboxItem: onycResolved.nttInboxItem,
        // On-chain `address = outflight_flow.payer` constraint —
        // close-target MUST equal the original `unlock_onyc` payer, who
        // may not be us. Read from the flow we just fetched.
        rentDestination: flow.payer as PublicKey,
        flowAmount,
        flowFogoSender,
        outboxItem: outboxItem.publicKey,
        release: await deriveSendUsdcReleaseAccounts(
          connection,
          usdcMint,
          nttProgram,
          input.wormholeCore ?? WORMHOLE_CORE_MAINNET,
          input.nttVersion ?? DEFAULT_NTT_VERSION,
          keypair.publicKey,
          outboxItem.publicKey,
        ),
      })
      .preInstructions([makePriorityFeeIx(ctx.priorityFeeMicroLamports), ...fundIxs])
      .signers([outboxItem])
      .rpc()

    metrics.txSent.inc({ instruction: 'send_usdc_to_user', result: 'ok' })
    metrics.flowAdvance.inc({
      leg: 'withdraw',
      from_status: 'WithdrawSwapped',
      to_status: 'WithdrawClosed',
    })

    return {
      kind: 'advanced',
      signatures: [sig],
      fromStatus: 'WithdrawSwapped',
      toStatus: 'WithdrawClosed',
    }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'send_usdc_to_user', result: 'error' })
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
 * Mirror of `deriveLockOnycReleaseAccounts` in `lock-onyc.ts`, but for
 * the USDC NTT manager. Asks the upstream NTT SDK to build the canonical
 * `release_wormhole_outbound` ix, then pulls the 7 PDA-derived accounts
 * the on-chain handler needs from positions [4], [5], [6], [7], [8],
 * [9], [14] of the resulting account list.
 *
 * Without this, the on-chain `send_usdc_to_user` handler will accept
 * only the `transfer_lock` accounts and fail the second CPI with
 * `InvalidAccountSplit` / missing-account errors.
 */
async function deriveSendUsdcReleaseAccounts(
  connection: Connection,
  usdcMint: PublicKey,
  nttProgram: PublicKey,
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
        manager: nttProgram.toBase58(),
        token: usdcMint.toBase58(),
        transceiver: { wormhole: nttProgram.toBase58() },
      },
    },
    nttVersion,
  )
  const xcvr = await ntt.getWormholeTransceiver()
  if (!xcvr) {
    throw new Error('SolanaNttWormholeTransceiver wiring failed for USDC manager.')
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
