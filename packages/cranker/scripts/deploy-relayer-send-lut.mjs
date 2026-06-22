#!/usr/bin/env node
/**
 * Deploys the Solana-mainnet Address Lookup Table for the relayer `send`
 * leg (NTT `transfer_lock` + `release_wormhole_outbound` + Flow close).
 *
 * Without it the v0 tx carries every account inline and overflows the
 * 1232-byte limit (observed 1271 on a live deposit). The table holds only
 * the STABLE accounts — per-flow keys (payer, inbox-item, flow PDA,
 * rent-destination, outbox-item, outbox-item-signer, wormhole-message,
 * session-authority) stay inline and are intentionally excluded.
 *
 * Covers BOTH directions in one table: deposit pushes the asset mint via
 * the ONyc manager, withdraw pushes the base mint via the USDC manager.
 *
 * PDA seeds mirror @fogo-onre/sdk builders/ntt.ts exactly (derived
 * manually here to avoid the SDK's ESM dir-import under bare `node`).
 *
 * Usage (preview):
 *   DRY_RUN=1 node packages/cranker/scripts/deploy-relayer-send-lut.mjs
 * Usage (deploy, GATED — signer must be tiaModT7):
 *   SOLANA_RPC_URL=<helius> AUTHORITY_KEYPAIR=$HOME/.config/solana/id.json \
 *   node packages/cranker/scripts/deploy-relayer-send-lut.mjs
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { homedir } from 'node:os'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from '@solana/web3.js'

const EXPECTED_SIGNER = 'tiaModT7KBWK1hNLFu94FogDGMs1haBZTupHujGzKLA'

const RELAYER_PROGRAM = new PublicKey('onrenRKgX54qtWeK3cuaTBE71xx7dWMXn82ubH61vAp')
const NTT_USDC = new PublicKey('nttu74CdAmsErx5daJVCQNoDZujswFrskMzonoZSdGk')
const NTT_ONYC = new PublicKey('nttpna5vXW7BN2Aa4AfTbkCncJWTEoBsnWvjS87Xgsd')
const WORMHOLE_CORE = new PublicKey('worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth')
const FOGO_CHAIN_ID = 51
const EXTEND_CHUNK = 20

const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0]

function chainIdBe(id) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(id)
  return b
}

function resolveRpc() {
  if (process.env.SOLANA_RPC_URL) {
    return process.env.SOLANA_RPC_URL
  }
  const cfg = execSync('solana config get', { encoding: 'utf8' })
  const m = cfg.match(/RPC URL:\s*(\S+)/)
  if (!m) {
    throw new Error('no SOLANA_RPC_URL and could not parse `solana config get`')
  }
  return m[1]
}

function loadKeypair(path) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf8'))))
}

/** Stable per-outbound-manager accounts the send leg references. */
function deriveManagerStable(manager, outboundMint) {
  const tokenAuthority = pda([Buffer.from('token_authority')], manager)
  const emitter = pda([Buffer.from('emitter')], manager)
  return [
    manager,
    pda([Buffer.from('config')], manager),
    pda([Buffer.from('outbox_rate_limit')], manager),
    pda([Buffer.from('inbox_rate_limit'), chainIdBe(FOGO_CHAIN_ID)], manager),
    pda([Buffer.from('peer'), chainIdBe(FOGO_CHAIN_ID)], manager),
    tokenAuthority,
    getAssociatedTokenAddressSync(outboundMint, tokenAuthority, true),
    pda([Buffer.from('registered_transceiver'), manager.toBuffer()], manager),
    emitter,
    pda([Buffer.from('Sequence'), emitter.toBuffer()], WORMHOLE_CORE),
  ]
}

async function sendAndConfirm(connection, payer, ix) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const tx = new Transaction({ blockhash, lastValidBlockHeight, feePayer: payer.publicKey }).add(ix)
  tx.sign(payer)
  const sig = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: 'confirmed' })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

function dedupe(keys) {
  const seen = new Set()
  const out = []
  for (const k of keys) {
    const s = k.toBase58()
    if (!seen.has(s)) {
      seen.add(s)
      out.push(k)
    }
  }
  return out
}

async function main() {
  const rpc = resolveRpc()
  const keypairPath = process.env.AUTHORITY_KEYPAIR ?? `${homedir()}/.config/solana/id.json`
  const connection = new Connection(rpc, 'confirmed')
  const authority = loadKeypair(keypairPath)
  console.log('RPC:       ', rpc)
  console.log('Authority: ', authority.publicKey.toBase58())
  if (authority.publicKey.toBase58() !== EXPECTED_SIGNER) {
    throw new Error(`signer mismatch: expected ${EXPECTED_SIGNER}, got ${authority.publicKey.toBase58()}`)
  }

  const configPda = pda([Buffer.from('relayer_config')], RELAYER_PROGRAM)
  const authorityPda = pda([Buffer.from('relayer')], RELAYER_PROGRAM)
  const cfgInfo = await connection.getAccountInfo(configPda)
  if (!cfgInfo) {
    throw new Error(`PairConfig ${configPda.toBase58()} not found`)
  }
  // PairConfig layout: 8-byte disc + base_mint(32) + asset_mint(32).
  const baseMint = new PublicKey(cfgInfo.data.subarray(8, 40))
  const assetMint = new PublicKey(cfgInfo.data.subarray(40, 72))
  console.log('baseMint (USDC.s): ', baseMint.toBase58())
  console.log('assetMint (ONyc):  ', assetMint.toBase58())

  const globals = [
    configPda,
    authorityPda,
    baseMint,
    assetMint,
    getAssociatedTokenAddressSync(baseMint, authorityPda, true),
    getAssociatedTokenAddressSync(assetMint, authorityPda, true),
    TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    SYSVAR_CLOCK_PUBKEY,
    SYSVAR_RENT_PUBKEY,
    WORMHOLE_CORE,
    pda([Buffer.from('Bridge')], WORMHOLE_CORE),
    pda([Buffer.from('fee_collector')], WORMHOLE_CORE),
  ]

  // deposit → ONyc manager pushes the asset mint; withdraw → USDC manager
  // pushes the base mint.
  const depositSet = deriveManagerStable(NTT_ONYC, assetMint)
  const withdrawSet = deriveManagerStable(NTT_USDC, baseMint)

  const all = dedupe([...globals, ...depositSet, ...withdrawSet])
  console.log(`\nStable accounts (${all.length}):`)
  for (const k of all) {
    console.log('  ', k.toBase58())
  }

  if (process.env.DRY_RUN === '1') {
    console.log('\nDRY_RUN=1 — not deploying.')
    return
  }

  // `recentSlot` is folded into the LUT PDA and validated on-chain against a
  // slot the processing leader has seen. `confirmed` can run ahead of that
  // leader → "not a recent slot". `finalized` is safely in the past.
  const slot = await connection.getSlot('finalized')
  const [createIx, lut] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot: slot,
  })
  console.log('\nLUT pubkey:', lut.toBase58())
  console.log('  created:', await sendAndConfirm(connection, authority, createIx))

  for (let i = 0; i < all.length; i += EXTEND_CHUNK) {
    const chunk = all.slice(i, i + EXTEND_CHUNK)
    const sig = await sendAndConfirm(connection, authority, AddressLookupTableProgram.extendLookupTable({
      payer: authority.publicKey,
      authority: authority.publicKey,
      lookupTable: lut,
      addresses: chunk,
    }))
    console.log(`  extended +${chunk.length} (${i + chunk.length}/${all.length}):`, sig)
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const resp = await connection.getAddressLookupTable(lut)
    if (resp.value && resp.value.state.addresses.length === all.length) {
      console.log('\nVerified: on-chain table has', resp.value.state.addresses.length, 'entries')
      break
    }
    await new Promise(r => setTimeout(r, 500))
  }

  console.log('\nDONE. Set the cranker env:')
  console.log(`  SEND_LOOKUP_TABLE=${lut.toBase58()}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
