#!/usr/bin/env tsx
/**
 * Diagnostic inspector for stuck `Flow` PDAs whose status enum tag was
 * written by an older relayer version. Bypasses Anchor's union decoder
 * (which crashes on unknown variants) by reading raw bytes at fixed
 * offsets — safe because `state.rs` documents the `Flow` field layout
 * as byte-stable across versions.
 *
 * Output is a single JSON object describing where the user's money
 * actually lives — enough to decide between (a) NTT-side cancellation,
 * (b) authority-signed ATA drain, (c) OnRe-side cancel of a legacy
 * redemption-request PDA, or (d) "already complete, just close the PDA".
 *
 * Usage (no local install — npx fetches tsx on demand):
 *   npx tsx scripts/inspect-stuck-flow.ts <ntt-inbox-item> [rpc-url]
 *
 * Example (mainnet):
 *   npx tsx scripts/inspect-stuck-flow.ts \
 *     FEjqpMcDJJpZRRFUnThF874GKVUUhx3ohnB9EepqNcBj \
 *     https://api.mainnet-beta.solana.com
 */
import { Buffer } from 'node:buffer'
import {
  findAuthorityPda,
  findConfigPda,
  findOutflightFlowPda,
  RELAYER_PROGRAM_ID,
} from '@fogo-onre/sdk'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'

// Anchor account discriminator is 8 bytes.
const DISC = 8

// `Flow` layout (state.rs:177) — byte-stable across relayer versions.
const FLOW_FOGO_SENDER_OFFSET = DISC + 0 //  8 .. 40
const FLOW_STATUS_TAG_OFFSET = DISC + 32 //       40
const FLOW_AMOUNT_OFFSET = DISC + 33 // 41 .. 49
const FLOW_PAYER_OFFSET = DISC + 41 // 49 .. 81

// `PairConfig` mint offsets (state.rs:9) — also byte-stable.
const CONFIG_USDC_MINT_OFFSET = DISC + 0 //  8 .. 40
const CONFIG_ONYC_MINT_OFFSET = DISC + 32 // 40 .. 72

async function main() {
  const [inboxItemArg, rpcArg] = process.argv.slice(2)
  if (!inboxItemArg) {
    console.error('Usage: inspect-stuck-flow.ts <ntt-inbox-item> [rpc-url]')
    process.exit(1)
  }
  const inboxItem = new PublicKey(inboxItemArg)
  const connection = new Connection(rpcArg ?? 'https://api.mainnet-beta.solana.com', 'confirmed')

  const [configPda] = findConfigPda()
  const [outflightFlow] = findOutflightFlowPda(inboxItem)
  const [authorityPda] = findAuthorityPda(RELAYER_PROGRAM_ID)

  const [configInfo, flowInfo, inboxItemInfo] = await Promise.all([
    connection.getAccountInfo(configPda),
    connection.getAccountInfo(outflightFlow),
    connection.getAccountInfo(inboxItem),
  ])

  if (!configInfo) {
    throw new Error(`PairConfig PDA ${configPda.toBase58()} not found — wrong cluster?`)
  }
  const configData = Buffer.from(configInfo.data)
  const usdcMint = new PublicKey(configData.subarray(CONFIG_USDC_MINT_OFFSET, CONFIG_USDC_MINT_OFFSET + 32))
  const onycMint = new PublicKey(configData.subarray(CONFIG_ONYC_MINT_OFFSET, CONFIG_ONYC_MINT_OFFSET + 32))

  const relayerUsdcAta = getAssociatedTokenAddressSync(usdcMint, authorityPda, true)
  const relayerOnycAta = getAssociatedTokenAddressSync(onycMint, authorityPda, true)

  const [usdcAtaInfo, onycAtaInfo] = await Promise.all([
    connection.getTokenAccountBalance(relayerUsdcAta).catch(() => null),
    connection.getTokenAccountBalance(relayerOnycAta).catch(() => null),
  ])

  const report: Record<string, unknown> = {
    nttInboxItem: inboxItem.toBase58(),
    outflightFlowPda: outflightFlow.toBase58(),
    relayerAuthorityPda: authorityPda.toBase58(),
    mints: { usdc: usdcMint.toBase58(), onyc: onycMint.toBase58() },
    relayerCustody: {
      onycAta: relayerOnycAta.toBase58(),
      onycBalance: onycAtaInfo?.value.uiAmountString ?? null,
      usdcAta: relayerUsdcAta.toBase58(),
      usdcBalance: usdcAtaInfo?.value.uiAmountString ?? null,
    },
  }

  if (!flowInfo) {
    report.flow = { exists: false, interpretation: 'No outflight Flow PDA — withdraw never reached `unlock_onyc`. Money is still in NTT inbox-item (if released) or upstream on FOGO.' }
  } else {
    const flowData = Buffer.from(flowInfo.data)
    const fogoSender = Buffer.from(flowData.subarray(FLOW_FOGO_SENDER_OFFSET, FLOW_FOGO_SENDER_OFFSET + 32)).toString('hex')
    const statusTag = flowData.readUInt8(FLOW_STATUS_TAG_OFFSET)
    const amount = flowData.readBigUInt64LE(FLOW_AMOUNT_OFFSET)
    const payer = new PublicKey(flowData.subarray(FLOW_PAYER_OFFSET, FLOW_PAYER_OFFSET + 32))

    // Best-effort tag interpretation. Current IDL exposes only Claimed=0,
    // Swapped=1. Higher values are legacy chain stages.
    const tagLabel = ({
      0: 'Claimed (new IDL: unlock_onyc done, ready for swap)',
      1: 'Swapped (new IDL: swap_onyc_to_usdc done, ready for send_usdc_to_user)',
      2: 'LEGACY: RedemptionPending (request_redemption_onyc done)',
      3: 'LEGACY: RedemptionApproved (OnRe approved request)',
      4: 'LEGACY: RedemptionClaimed (claim_redemption_usdc done, USDC in relayer ATA)',
    } as Record<number, string>)[statusTag] ?? `unknown tag ${statusTag}`

    report.flow = {
      exists: true,
      lamports: flowInfo.lamports,
      ownerProgram: flowInfo.owner.toBase58(),
      decoded: {
        statusTag,
        statusInterpretation: tagLabel,
        amountRaw: amount.toString(),
        fogoSenderHex: `0x${fogoSender}`,
        payer: payer.toBase58(),
      },
    }
  }

  if (!inboxItemInfo) {
    report.nttInbox = { exists: false }
  } else {
    report.nttInbox = {
      exists: true,
      lamports: inboxItemInfo.lamports,
      ownerProgram: inboxItemInfo.owner.toBase58(),
      dataLen: inboxItemInfo.data.length,
      hint: 'See NTT IDL for inbox-item byte layout (recipient_address, amount, release_status).',
    }
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error('inspect-stuck-flow failed:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
