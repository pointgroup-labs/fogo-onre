#!/usr/bin/env node
/**
 * One-shot companion to `release-stuck-usdc-outbox.mjs`.
 *
 * Background: `send_usdc_to_user.rs` only calls NTT `transfer_lock`,
 * so the Wormhole VAA for a completed withdraw never gets published
 * unless a separate `release_wormhole_outbound` is invoked. That
 * sibling script publishes the VAA on Solana; guardians then sign it
 * (~30s). This script picks up where guardians stop: it fetches the
 * signed VAA, ensures the recipient ATA exists on FOGO, and drives
 * NTT's `post_vaa + receive_message + redeem + release_inbound_mint`
 * sequence against the FOGO-side USDC.s manager so the user actually
 * receives USDC.s.
 *
 * Mirrors the proven pattern in
 * `packages/cranker/src/bridge/sdk-redeem.ts` — same chain registration,
 * same NTT_VERSION, same FOGO_WORMHOLE_CORE, same redeem-loop shape.
 *
 * Usage:
 *   FOGO_RPC_URL=https://mainnet.fogo.io \
 *   SOLANA_KEYPAIR=/path/to/keypair.json \
 *   VAA_SEQUENCE=40440 \
 *   node scripts/redeem-stuck-usdc-fogo.mjs
 *
 *   Optional:
 *     --dry-run                  parse VAA and print plan, no submit
 *     VAA_HEX=0xdeadbeef…       use these VAA bytes instead of Wormholescan
 *     VAA_EMITTER_HEX=<64hex>    emitter (default: USDC.s NTT manager on Solana)
 *     VAA_EMITTER_CHAIN=1        source chain id (default: 1 = Solana)
 */

import fs from 'node:fs'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js'
import { deserialize } from '@wormhole-foundation/sdk-definitions'
import { register as registerNttDefinitions } from '@wormhole-foundation/sdk-definitions-ntt'
import { register as registerSolanaNtt, SolanaNtt } from '@wormhole-foundation/sdk-solana-ntt'

registerNttDefinitions()
registerSolanaNtt()

const FOGO_RPC = process.env.FOGO_RPC_URL ?? 'https://mainnet.fogo.io'
const KEYPAIR_PATH = process.env.SOLANA_KEYPAIR
const VAA_SEQUENCE = process.env.VAA_SEQUENCE ?? '40440'
const VAA_EMITTER_CHAIN = process.env.VAA_EMITTER_CHAIN ?? '1'
const VAA_EMITTER_HEX
  = process.env.VAA_EMITTER_HEX
    ?? '0bc1d0653e7fe51c48f66bfe24ca6466ba541770dc89b3ac3050ddd892e3f889'
const VAA_HEX = process.env.VAA_HEX

if (!KEYPAIR_PATH) {
  console.error('Set SOLANA_KEYPAIR=/path/to/keypair.json (must be a FOGO-funded keypair)')
  process.exit(1)
}

const dryRun = process.argv.includes('--dry-run')

// FOGO addresses (mirror packages/webapp/src/constants.ts).
const FOGO_USDC_S_MINT = new PublicKey('uSd2czE61Evaf76RNbq4KPpXnkiL3irdzgLFUMe3NoG')
const FOGO_USDC_S_NTT_MANAGER = new PublicKey('nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk')
// FOGO has its own Wormhole Core deployment, distinct from Solana's.
const FOGO_WORMHOLE_CORE = 'worm2mrQkG1B1KTz37erMfWN8anHkSK24nzca7UD8BB'
const NETWORK = 'Mainnet'
const FOGO_CHAIN = 'Fogo'
const NTT_VERSION = '3.0.0'

const TX_CONFIRM_TIMEOUT_MS = 90_000

function loadKeypair(path) {
  const raw = fs.readFileSync(path, 'utf8')
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
}

async function fetchVaaBytes() {
  if (VAA_HEX) {
    return Uint8Array.from(Buffer.from(VAA_HEX.replace(/^0x/, ''), 'hex'))
  }
  const url
    = `https://api.wormholescan.io/api/v1/vaas/${VAA_EMITTER_CHAIN}/${VAA_EMITTER_HEX}/${VAA_SEQUENCE}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Wormholescan ${res.status} for ${url}: ${await res.text()}`)
  }
  const json = await res.json()
  const b64 = json?.data?.vaa
  if (!b64) {
    throw new Error(`No data.vaa in response: ${JSON.stringify(json).slice(0, 400)}`)
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'))
}

/**
 * Pulls the recipient owner pubkey out of a deserialized NTT VAA.
 * Layout: WormholeTransceiverMessage → NttManagerMessage → NativeTokenTransfer.
 * On Solana/FOGO the 32-byte UniversalAddress IS the owner pubkey.
 */
function extractRecipientOwner(vaa) {
  const nativeTransfer = vaa.payload.nttManagerPayload.payload
  return new PublicKey(nativeTransfer.recipientAddress.toUint8Array())
}

async function ensureRecipientAta(connection, payer, owner) {
  const ata = getAssociatedTokenAddressSync(FOGO_USDC_S_MINT, owner, true)
  const existing = await connection.getAccountInfo(ata)
  if (existing) {
    console.log('recipient ATA already exists:', ata.toBase58())
    return ata
  }
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      ata,
      owner,
      FOGO_USDC_S_MINT,
    ),
  )
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: 'confirmed',
    skipPreflight: false,
  })
  console.log('recipient ATA created:', ata.toBase58(), 'sig:', sig)
  return ata
}

async function main() {
  const connection = new Connection(FOGO_RPC, 'confirmed')
  const payer = loadKeypair(KEYPAIR_PATH)

  console.log('FOGO RPC:            ', FOGO_RPC)
  console.log('Payer (FOGO):        ', payer.publicKey.toBase58())
  console.log('USDC.s mint (FOGO):  ', FOGO_USDC_S_MINT.toBase58())
  console.log('USDC.s NTT manager:  ', FOGO_USDC_S_NTT_MANAGER.toBase58())
  console.log('VAA emitter chain:   ', VAA_EMITTER_CHAIN)
  console.log('VAA emitter:         ', VAA_EMITTER_HEX)
  console.log('VAA sequence:        ', VAA_SEQUENCE)

  const vaaBytes = await fetchVaaBytes()
  console.log('VAA bytes:           ', vaaBytes.length, 'B')

  const vaa = deserialize('Ntt:WormholeTransfer', vaaBytes)
  const recipientOwner = extractRecipientOwner(vaa)
  const trimmed = vaa.payload.nttManagerPayload.payload.trimmedAmount
  console.log('VAA recipient owner: ', recipientOwner.toBase58())
  console.log('VAA toChain:         ', vaa.payload.nttManagerPayload.payload.recipientChain)
  console.log('VAA trimmedAmount:   ', `${trimmed.amount.toString()} (decimals=${trimmed.decimals})`)

  const ntt = new SolanaNtt(
    NETWORK,
    FOGO_CHAIN,
    connection,
    {
      coreBridge: FOGO_WORMHOLE_CORE,
      ntt: {
        manager: FOGO_USDC_S_NTT_MANAGER.toBase58(),
        token: FOGO_USDC_S_MINT.toBase58(),
        transceiver: { wormhole: FOGO_USDC_S_NTT_MANAGER.toBase58() },
      },
    },
    NTT_VERSION,
  )

  try {
    if (await ntt.getIsExecuted(vaa)) {
      console.log('\nVAA already executed on FOGO — nothing to do.')
      return
    }
  } catch (err) {
    console.log('getIsExecuted probe failed (continuing):', err?.message ?? err)
  }

  if (dryRun) {
    const ata = getAssociatedTokenAddressSync(FOGO_USDC_S_MINT, recipientOwner, true)
    console.log('\n--dry-run')
    console.log('would create-if-missing ATA:', ata.toBase58())
    console.log('would invoke SolanaNtt.redeem against FOGO manager.')
    return
  }

  await ensureRecipientAta(connection, payer, recipientOwner)

  console.log('\nStarting SolanaNtt.redeem sequence on FOGO...')
  let stepIdx = 0
  let lastSig = null
  for await (const unsigned of ntt.redeem([vaa], payer.publicKey)) {
    stepIdx += 1
    const stx = unsigned.transaction
    const description = unsigned.description ?? `step-${stepIdx}`
    const extraSigners = stx.signers ?? []
    const inner = stx.transaction

    let sig
    if (inner instanceof VersionedTransaction) {
      inner.sign([payer, ...extraSigners])
      const raw = inner.serialize()
      sig = await connection.sendRawTransaction(raw, { skipPreflight: false })
      const latest = await connection.getLatestBlockhash('confirmed')
      await connection.confirmTransaction(
        { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
        'confirmed',
      )
    } else {
      sig = await sendAndConfirmTransaction(
        connection,
        inner,
        [payer, ...extraSigners],
        { commitment: 'confirmed', skipPreflight: false },
      )
    }
    lastSig = sig
    console.log(`  [${stepIdx}] ${description}: ${sig}`)
  }

  if (!lastSig) {
    console.log('\nSDK yielded zero transactions — VAA may have been redeemed by another path.')
    return
  }

  const recipientAta = getAssociatedTokenAddressSync(FOGO_USDC_S_MINT, recipientOwner, true)
  console.log('\nRedeem complete.')
  console.log('Recipient ATA:', recipientAta.toBase58())
  console.log('Final tx:     ', lastSig)
  console.log(`Verify balance: solana balance --url ${FOGO_RPC} -t ${FOGO_USDC_S_MINT.toBase58()} ${recipientOwner.toBase58()}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
