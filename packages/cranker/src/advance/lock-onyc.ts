import type { AdvanceContext, AdvanceResult } from './types'
import { findAuthorityPda, findInboxRateLimitPda, findNttPeerPda, findSessionAuthorityPda, FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID, NTT_USDC_PROGRAM_ID, nttTransferArgsHash } from '@fogo-onre/sdk'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { resolveNttVaa } from '../vaa'
import { DEFAULT_NTT_VERSION, deriveLockOnycReleaseAccounts, describeStatus, fetchVaaBytes, makeSolanaNtt, WORMHOLE_CORE_MAINNET } from './helpers'

export type LockOnycInput = {
  fogoTx: string
  vaaHex?: string
  onycMint?: PublicKey
  nttProgram?: PublicKey
  rentDestination?: PublicKey
  nttVersion?: string
  wormholeCore?: string
}

// NTT charges OutboxItem rent (~1,858,320 lamports) from `relayer_authority`
// via invoke_signed; target debit + rent-exempt + headroom = 3M.
const RELAYER_AUTH_TOPUP = 3_000_000n
// session_authority is signer-only; 2M leaves it well above rent-exempt.
const SESSION_AUTH_TOPUP = 2_000_000n

/**
 * Step 3: NTT `transfer_lock` ONyc back to FOGO as ONyc, closes the
 * inflight Flow. Ported from CLI:412-627.
 *
 * Two notable noop branches:
 *  - FOGO peer not registered on ONyc NTT manager → noop (this is the
 *    documented ONyc-deploy gate, not an error). The Flow stays in
 *    status=Swapped; cranker retries on the next scan once peer is set.
 *  - Flow status not Swapped → noop (someone else advanced or this leg
 *    already landed and the Flow was closed).
 */
export async function lockOnyc(
  ctx: AdvanceContext,
  input: LockOnycInput,
): Promise<AdvanceResult> {
  const { connection, keypair, client, metrics } = ctx
  const nttProgram = input.nttProgram ?? NTT_USDC_PROGRAM_ID
  const rentDestination = input.rentDestination ?? keypair.publicKey

  try {
    const vaaBytes = await fetchVaaBytes({
      fogoTx: input.fogoTx,
      vaaHex: input.vaaHex,
      wormholescanUrl: ctx.wormholescanUrl,
      timeoutMs: ctx.wormholescanTimeoutMs,
    })
    const resolved = resolveNttVaa({ vaaBytes, nttProgramId: nttProgram })

    const flow = await client.fetchInflightFlow(resolved.nttInboxItem).catch(() => null)
    if (!flow) {
      return {
        kind: 'noop',
        reason: `no Flow for inbox-item ${resolved.nttInboxItem.toBase58()} — prior steps haven't run`,
      }
    }
    const flowStatus = describeStatus(flow.status)
    if (flowStatus !== 'Swapped') {
      return {
        kind: 'noop',
        reason: `Flow status is ${flowStatus}, expected Swapped`,
      }
    }

    const cfg = await client.fetchConfig()
    const onycMint = input.onycMint ?? (cfg.onycMint as PublicKey)

    const flowFogoSender = Uint8Array.from(flow.fogoSender as ArrayLike<number>)
    const flowAmount = BigInt(flow.amount.toString())

    const outboxItem = Keypair.generate()

    // Pre-flight: FOGO chain registered on ONyc NTT manager (deploy gate)
    const [fogoPeerPda] = findNttPeerPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
    const [fogoInboxRateLimitPda] = findInboxRateLimitPda(FOGO_WORMHOLE_CHAIN_ID, NTT_ONYC_PROGRAM_ID)
    const [peerInfo, inboxRateLimitInfo] = await Promise.all([
      connection.getAccountInfo(fogoPeerPda).catch(() => null),
      connection.getAccountInfo(fogoInboxRateLimitPda).catch(() => null),
    ])
    if (!peerInfo || !inboxRateLimitInfo) {
      const missing: string[] = []
      if (!peerInfo) {
        missing.push(`peer (${fogoPeerPda.toBase58()})`)
      }
      if (!inboxRateLimitInfo) {
        missing.push(`inbox_rate_limit (${fogoInboxRateLimitPda.toBase58()})`)
      }
      return {
        kind: 'noop',
        reason: `FOGO chain not registered on ONyc NTT manager: missing ${missing.join(' and ')}. Awaiting ONyc deploy.`,
      }
    }

    // Lamport top-ups for relayer_authority (NTT debits OutboxItem rent
    // from this PDA via invoke_signed) and session_authority.
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
      NTT_ONYC_PROGRAM_ID,
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

    const wormholeCore = input.wormholeCore ?? WORMHOLE_CORE_MAINNET
    const nttVersion = input.nttVersion ?? DEFAULT_NTT_VERSION
    const onycNtt = await makeSolanaNtt({
      connection,
      manager: NTT_ONYC_PROGRAM_ID,
      token: onycMint,
      wormholeCore,
      version: nttVersion,
    })
    const release = await deriveLockOnycReleaseAccounts(
      onycNtt,
      keypair.publicKey,
      outboxItem.publicKey,
    )

    const sig = await client
      .lockOnyc({
        payer: keypair.publicKey,
        onycMint,
        nttInboxItem: resolved.nttInboxItem,
        rentDestination,
        flowAmount,
        flowFogoSender,
        outboxItem: outboxItem.publicKey,
        release,
      })
      .preInstructions(fundIxs)
      .signers([outboxItem])
      .rpc()

    metrics.txSent.inc({ instruction: 'lock_onyc', result: 'ok' })
    metrics.flowAdvance.inc({ leg: 'deposit', from_status: 'Swapped', to_status: 'Closed' })

    return {
      kind: 'advanced',
      signatures: [sig],
      fromStatus: 'Swapped',
      toStatus: 'Closed',
    }
  } catch (err) {
    metrics.txSent.inc({ instruction: 'lock_onyc', result: 'error' })
    return {
      kind: 'error',
      error: err instanceof Error ? err : new Error(String(err)),
      partialSignatures: [],
    }
  }
}
