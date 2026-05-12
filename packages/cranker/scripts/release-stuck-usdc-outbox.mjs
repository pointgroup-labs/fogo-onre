#!/usr/bin/env node
/**
 * One-shot recovery for the withdraw return leg.
 *
 * Background: `send_usdc_to_user.rs` only calls NTT `transfer_lock` and never
 * follows up with `release_wormhole_outbound`, so the outbound NTT message
 * stages an OutboxItem but never publishes a Wormhole VAA. The user's USDC
 * sits in the Solana NTT manager's custody indefinitely.
 *
 * This script publishes the VAA for a specific OutboxItem by invoking
 * `release_wormhole_outbound` on the USDC NTT manager directly. The
 * instruction is permissionless — anyone can pay rent and post — so a
 * cranker-authority keypair (or any funded keypair) is sufficient.
 *
 * After this tx confirms, guardians sign the VAA in ~30s. Then redeem on
 * FOGO's USDC.s manager to actually mint to the user.
 *
 * Usage:
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *   SOLANA_KEYPAIR=/path/to/keypair.json \
 *   OUTBOX_ITEM=BM8Bb4nMdMgWCRMGsX6GNspU2ez8gb8WGjW1tpYjFLN1 \
 *   node scripts/release-stuck-usdc-outbox.mjs
 *
 *   Optional: --dry-run prints the instruction without sending.
 */

import fs from 'node:fs'
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js'
import { SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const KEYPAIR_PATH = process.env.SOLANA_KEYPAIR
const OUTBOX_ITEM_STR
  = process.env.OUTBOX_ITEM
    ?? 'BM8Bb4nMdMgWCRMGsX6GNspU2ez8gb8WGjW1tpYjFLN1'

if (!KEYPAIR_PATH) {
  console.error('Set SOLANA_KEYPAIR=/path/to/keypair.json')
  process.exit(1)
}

const dryRun = process.argv.includes('--dry-run')

// USDC NTT manager (same on Solana + FOGO), mint, Wormhole core.
const USDC_NTT_MANAGER = new PublicKey('nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk')
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const WORMHOLE_CORE = 'worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth'
const NTT_VERSION = '3.0.0'

function loadKeypair(path) {
  const raw = fs.readFileSync(path, 'utf8')
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
}

async function main() {
  const connection = new Connection(RPC, 'confirmed')
  const payer = loadKeypair(KEYPAIR_PATH)
  const outboxItem = new PublicKey(OUTBOX_ITEM_STR)

  console.log('RPC:                 ', RPC)
  console.log('Payer:               ', payer.publicKey.toBase58())
  console.log('USDC NTT manager:    ', USDC_NTT_MANAGER.toBase58())
  console.log('USDC mint:           ', USDC_MINT.toBase58())
  console.log('OutboxItem:          ', outboxItem.toBase58())

  // Sanity-check the OutboxItem is real and owned by the NTT manager.
  const info = await connection.getAccountInfo(outboxItem)
  if (!info) {
    throw new Error(`OutboxItem ${outboxItem.toBase58()} does not exist on RPC ${RPC}`)
  }
  if (!info.owner.equals(USDC_NTT_MANAGER)) {
    throw new Error(
      `OutboxItem ${outboxItem.toBase58()} is owned by ${info.owner.toBase58()}, `
      + `expected USDC NTT manager ${USDC_NTT_MANAGER.toBase58()}`,
    )
  }
  console.log('OutboxItem owner:     OK (NTT manager)')
  console.log('OutboxItem size:     ', info.data.length, 'bytes')

  // Build NTT v3 release_wormhole_outbound via the Wormhole SDK.
  // The SDK derives all 15 accounts (manager Config, transceiver, wormhole
  // bridge / fee_collector / sequence, message PDA, emitter, outbox_item_signer)
  // from on-chain state, matching the mainnet-verified ordering used by the
  // relayer's `lock_onyc` handler.
  const ntt = new SolanaNtt(
    'Mainnet',
    'Solana',
    connection,
    {
      coreBridge: WORMHOLE_CORE,
      ntt: {
        manager: USDC_NTT_MANAGER.toBase58(),
        token: USDC_MINT.toBase58(),
        transceiver: { wormhole: USDC_NTT_MANAGER.toBase58() },
      },
    },
    NTT_VERSION,
  )
  const xcvr = await ntt.getWormholeTransceiver()
  if (!xcvr) {
    throw new Error('Wormhole transceiver wiring failed (SolanaNtt.getWormholeTransceiver returned null)')
  }
  const ix = await xcvr.createReleaseWormholeOutboundIx(
    payer.publicKey,
    outboxItem,
    false, // revertOnDelay — match relayer’s lock_onyc default (do not revert)
  )

  console.log('\nrelease_wormhole_outbound accounts (15):')
  ix.keys.forEach((k, i) => {
    console.log(`  [${i.toString().padStart(2)}] ${k.pubkey.toBase58()}  s=${k.isSigner} w=${k.isWritable}`)
  })

  if (dryRun) {
    console.log('\n--dry-run: not sending tx')
    return
  }

  const tx = new Transaction().add(ix)
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: 'confirmed',
    skipPreflight: false,
  })
  console.log('\nrelease_wormhole_outbound posted. tx:', sig)
  console.log('Wormhole VAA will be signed by guardians (~30s).')
  console.log(`Track at: https://wormholescan.io/#/tx/${sig}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
